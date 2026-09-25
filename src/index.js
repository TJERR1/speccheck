import { checkRequirements, checkParagraphs, UserError } from "./checker.js";

const MAX_INPUT_CHARS = 30_000;

// Static files in public/ are served by the assets binding; this handles the API.
// Stateless: pasted text lives only in this request and is never stored or logged.
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === "POST" && pathname === "/api/check") {
      return handleCheck(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleCheck(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  // A Word upload is parsed in the browser and arrives as its paragraph texts;
  // the document itself never reaches the Worker.
  const paragraphs = Array.isArray(body.paragraphs) ? body.paragraphs : null;
  if (paragraphs && !paragraphs.every((p) => typeof p === "string")) {
    return json({ error: "paragraphs must be an array of strings." }, 400);
  }
  const text = paragraphs ? paragraphs.join("\n") : typeof body.text === "string" ? body.text : "";
  if (text.trim() === "") {
    return json({ error: paragraphs ? "That document has no text to check." : "Paste some requirements first." }, 400);
  }
  if (text.length > MAX_INPUT_CHARS) {
    const what = paragraphs ? "That document is too long. Upload at most" : "That's too long. Paste at most";
    return json({ error: `${what} ${MAX_INPUT_CHARS.toLocaleString()} characters at a time.` }, 400);
  }

  try {
    const clauses = paragraphs
      ? await checkParagraphs(paragraphs, env.OPENCODE_API_KEY)
      : await checkRequirements(text, env.OPENCODE_API_KEY);
    return json({ clauses });
  } catch (err) {
    if (err instanceof UserError) return json({ error: err.message }, 400);
    // Log the failure type only, never the pasted text.
    console.error("check failed:", err.name, err.message.slice(0, 200));
    const timedOut = err.name === "TimeoutError";
    return json(
      { error: timedOut ? "The check took too long. Try a shorter section." : "The checker is unavailable right now. Try again in a moment." },
      502,
    );
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
