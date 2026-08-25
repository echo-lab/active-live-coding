// Every REST endpoint in src/server/main.js returns HTTP 200 even on failure
// (res.json({ error: error.message })) -- so callers must check json.error,
// not response.ok/status, to detect a failed request.

async function timed(fn) {
  const t0 = performance.now();
  try {
    const result = await fn();
    return { ...result, latencyMs: performance.now() - t0 };
  } catch (error) {
    return { ok: false, error: error.message, latencyMs: performance.now() - t0 };
  }
}

export async function timedPost(url, body) {
  return timed(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    return { httpStatus: res.status, json, ok: json.error == null };
  });
}

export async function timedGet(url) {
  return timed(async () => {
    const res = await fetch(url);
    const json = await res.json();
    return { httpStatus: res.status, json, ok: json.error == null };
  });
}

export async function timedDelete(url) {
  return timed(async () => {
    const res = await fetch(url, { method: "DELETE" });
    const json = await res.json();
    return { httpStatus: res.status, json, ok: json.error == null };
  });
}
