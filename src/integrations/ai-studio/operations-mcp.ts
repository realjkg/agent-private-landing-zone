import type { UnifiedOperations, VerifiedCaller } from "../../operations/unified.js";

type RpcRequest = { jsonrpc:"2.0"; id?:string|number; method:string; params?:unknown };
type RpcResponse = {jsonrpc:"2.0";id:string|number|null;result?:unknown;error?:{code:number;message:string}};
const definitions = [
  {name:"alz.operations.list", description:"List approved read-only ALZ operations.",
   inputSchema:{type:"object",properties:{},additionalProperties:false}},
  {name:"alz.operations.invoke",description:"Run an approved READ_ONLY operation through the ALZ Operations API.",
   inputSchema:{type:"object",properties:{
     operation:{type:"string",pattern:"^[a-z][a-z0-9-]{1,40}$"},
     inputs:{type:"object",additionalProperties:true}
   },required:["operation"],additionalProperties:false}}
] as const;
const err=(id:string|number|null,code:number,message:string):RpcResponse=>({
  jsonrpc:"2.0",id,error:{code,message}
});
const ok=(id:string|number,result:unknown):RpcResponse=>({jsonrpc:"2.0",id,result});
const isObject=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==="object"&&!Array.isArray(x);
const idOk=(x:unknown):x is string|number=>typeof x==="string"&&x.length<=128 ||
  typeof x==="number"&&Number.isSafeInteger(x);

/** Protocol adapter: no HTTP listener or unverifiable OAuth token acceptance. */
export class StudioMcpAdapter {
  constructor(private readonly operations:UnifiedOperations) {}
  async dispatch(caller:VerifiedCaller|undefined,raw:unknown):Promise<RpcResponse> {
    if (!isObject(raw) || raw.jsonrpc!=="2.0" || typeof raw.method!=="string" || !idOk(raw.id))
      return err(null,-32600,"INVALID_REQUEST");
    const req=raw as RpcRequest;
    const id=req.id as string|number;
    if (!caller || caller.verifiedBy!=="TRUSTED_GATEWAY")
      return err(id,-32001,"UNAUTHENTICATED");
    if (req.method==="initialize") {
      try {this.operations.list(caller);} catch {return err(id,-32003,"FORBIDDEN");}
      return ok(id,{protocolVersion:"2025-03-26",capabilities:{tools:{listChanged:false}},
        serverInfo:{name:"sovereign-alz-readonly",version:"0.1.0"}});
    }
    if (req.method==="tools/list") {
      try {this.operations.list(caller);} catch {return err(id,-32003,"FORBIDDEN");}
      return ok(id,{tools:definitions});
    }
    if (req.method!=="tools/call")return err(id,-32601,"METHOD_NOT_FOUND");
    if (!isObject(req.params)||typeof req.params.name!=="string"||!isObject(req.params.arguments??{}))
      return err(id,-32602,"INVALID_PARAMS");
    const args=req.params.arguments??{};
    if (!isObject(args))return err(id,-32602,"INVALID_PARAMS");
    if (req.params.name==="alz.operations.list") {
      if(Object.keys(args).length)return err(id,-32602,"INVALID_PARAMS");
      try {return ok(id,{content:[{type:"text",text:JSON.stringify(this.operations.list(caller))}]});}
      catch{return err(id,-32003,"FORBIDDEN");}
    }
    if(req.params.name==="alz.operations.invoke") {
      if(typeof args.operation!=="string"|| !/^[a-z][a-z0-9-]{1,40}$/.test(args.operation)||
        Object.keys(args).some(k=>!["operation","inputs"].includes(k))||
        !isObject(args.inputs??{}))return err(id,-32602,"INVALID_PARAMS");
      const result=await this.operations.invoke(caller,args.operation,args.inputs??{});
      return ok(id,{isError:!result.ok,content:[{type:"text",text:JSON.stringify(result)}]});
    }
    return err(id,-32602,"TOOL_NOT_ALLOWED");
  }
}
