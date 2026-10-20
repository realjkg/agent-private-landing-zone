import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { VerifiedCaller } from "../../operations/unified.js";
import { StudioMcpAdapter } from "./operations-mcp.js";

export type BearerVerifier = (token: string) => Promise<VerifiedCaller | null>;
export type IngressOptions = {
  /** A real cryptographic token verifier must be injected by the trusted host. */
  verifyBearer: BearerVerifier;
  adapter: StudioMcpAdapter;
  maxBodyBytes?: number;
};
function reply(res: ServerResponse, code:number, result:unknown):void {
  res.writeHead(code,{"content-type":"application/json","cache-control":"no-store",
    "x-content-type-options":"nosniff", ...(code >= 400 ? { connection: "close" } : {})});
  res.end(JSON.stringify(result));
}
async function readBody(req:IncomingMessage, max:number):Promise<unknown> {
  let size=0; const chunks:Buffer[]=[];
  // Preserve the response socket when rejecting an oversized streaming body.
  for await(const part of req.iterator({ destroyOnReturn: false })) {
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
  const server = createServer(async (req,res)=>{
    // Server-to-server only: browser origins are never trusted implicitly.
    if (req.headers.origin !== undefined) {reply(res,403,{error:"ORIGIN_DENIED"});return;}
    if (!/^127\.0\.0\.1(?::[0-9]{1,5})?$/.test(req.headers.host ?? "")) {
      reply(res,403,{error:"HOST_DENIED"});return;
    }
    if(req.url!=="/mcp" || req.method!=="POST") {reply(res,404,{error:"NOT_FOUND"});return;}
    if(req.headers["content-type"]?.split(";")[0].toLowerCase()!=="application/json") {
      reply(res,415,{error:"UNSUPPORTED_MEDIA_TYPE"});return;
    }
    const auth=req.headers.authorization;
    const match=typeof auth==="string"?/^Bearer ([A-Za-z0-9._~+/-]{16,8192})$/.exec(auth):null;
    if(!match){reply(res,401,{error:"UNAUTHENTICATED"});return;}
    let caller:VerifiedCaller|null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {caller=await Promise.race([options.verifyBearer(match[1]), new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), 3000);
    })]);}
    catch {reply(res,401,{error:"UNAUTHENTICATED"});return;}
    finally { if (timer) clearTimeout(timer); }
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
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;
  return server;
}
/** The only supported default listener address is loopback. Call listen externally. */
export const PRIVATE_MCP_BIND_HOST="127.0.0.1" as const;
