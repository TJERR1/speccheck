// OpenAI-compatible chat completions client for the OpenCode Go endpoint.
// Uses only fetch, so it runs in both the Worker and Node (for the eval).

export const LLM_BASE_URL = "https://opencode.ai/zen/go/v1";
export const LLM_MODEL = "deepseek-v4-flash";
// The endpoint's latency varies a lot (3-63 s for the same size of request), so leave
// headroom. Workers limit CPU time, not time spent waiting on fetch.
const LLM_TIMEOUT_MS = 120_000;

/**
 * Send messages to the model and return the parsed JSON object it replies with.
 * The model is told to answer with JSON only; code fences are tolerated.
 */
export async function callModelJson(messages, apiKey, { model = LLM_MODEL, timeoutMs = LLM_TIMEOUT_MS } = {}) {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      // The Go endpoint requires a session id; one per check keeps routing consistent.
      "x-opencode-session": crypto.randomUUID(),
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`LLM returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return parseJsonReply(data.choices[0].message.content);
}

export function parseJsonReply(content) {
  const text = String(content ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("Model reply did not contain a JSON object");
  }
  return JSON.parse(body.slice(start, end + 1));
}
