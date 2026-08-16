export async function getJson(url: string, headers: Record<string,string> = {}, timeoutMs = 7000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

export async function postJson(url: string, body: unknown, headers: Record<string,string> = {}, timeoutMs = 12000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
