import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { VerifiedCaller } from "../../operations/unified.js";
import { StudioMcpAdapter } from "./operations-mcp.js";

export type BearerVerifier = (token: string) => Promise<VerifiedCaller | null>;
export type IngressOptions = {
  /** A real cryptographic token verifier must be injected by the trusted host. */
  verifyBearer: BearerVerifier;
  adapter: StudioMcpAdapter;
  /** Defaults to loopback. Remote ingress requires an external authenticated private TLS proxy. */
  host?: "127.0.0.1" | "::1";
  maxBodyBytes?: number;
};
function reply(res: ServerResponse, code:number, result:unknown):void {
  res.writeHead(code,{"content-type":"application/json","cache-control":"no-store",
    "x-content-type-options":"nosniff","access-control-allow-origin":"null"});
  res.end(JSON.stringify(result));
}
async function readBody(req:IncomingMessage, max:number):Promise<unknown> {
  let size=0; const chunks:Buffer[]=[];
  for await(const part of req) {
    const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);
    size+=chunk.length;
    if(size>max)throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}
  catch {throw new Error("INVALID_JSON");}
}
export function createPrivateMcpServer(options:IngressOptions):Server {
  if(!options.verifyBearer)throw new Error("MCP_TOKEN_VERIFIER_REQUIRED");
  const max=options.maxBodyBytes??64*1024;
  if(!Number.isSafeInteger(max)||max<1024||max>1024*1024)throw new Error("MCP_BODY_LIMIT_INVALID");
  return createServer(async (req,res)=>{
    if(req.url!=="/mcp" || req.method!=="POST") {reply(res,404,{error:"NOT_FOUND"});return;}
    if(req.headers["content-type"]?.split(";")[0].toLowerCase()!=="application/json") {
      reply(res,415,{error:"UNSUPPORTED_MEDIA_TYPE"});return;
    }
    const auth=req.headers.authorization;
    const match=typeof auth==="string"?/^Bearer ([A-Za-z0-9._~+/-]{16,4096})$/.exec(auth):null;
    if(!match){reply(res,401,{error:"UNAUTHENTICATED"});return;}
    let caller:VerifiedCaller|null;
    try {caller=await options.verifyBearer(match[1]);}
    catch {reply(res,401,{error:"UNAUTHENTICATED"});return;}
    if(!caller||caller.verifiedBy!=="TRUSTED_GATEWAY") {
      reply(res,401,{error:"UNAUTHENTICATED"});return;
    }
    try {
      const payload=await readBody(req,max);
      const result=await options.adapter.dispatch(caller,payload);
      reply(res,200,result);
    }catch(e) {
      const code=e instanceof Error && e.message==="PAYLOAD_TOO_LARGE"?413:400;
      reply(res,code,{error:code===413?"PAYLOAD_TOO_LARGE":"INVALID_JSON"});
    }
  });
}
/** The only supported default listener address is loopback. Call listen externally. */
export const PRIVATE_MCP_BIND_HOST="127.0.0.1" as const;
