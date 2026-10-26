/**
 * The agent runtime's framework (LangChain and LangGraph) uploads every graph input and output to a hosted tracing
 * service when the process environment asks it to: LANGSMITH_TRACING or LANGCHAIN_TRACING_V2 with an API key. A
 * sovereign deployment never sends prompts or state off the host, so the session graph removes those variables before
 * it runs. Removing them from this process also keeps them from every child process it starts.
 */
const HOSTED_TRACING_VARIABLE = /^(?:LANGSMITH_|LANGCHAIN_(?:TRACING|API_KEY|ENDPOINT|PROJECT|SESSION|CALLBACKS_BACKGROUND))/;

/** Removes the hosted-tracing variables from `env` and returns their names (never their values). */
export function disableHostedTracing(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = Object.keys(env).filter((name) => HOSTED_TRACING_VARIABLE.test(name)).sort();
  for (const name of removed) delete env[name];
  return removed;
}
