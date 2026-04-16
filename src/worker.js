/**
 * Cloudflare Worker: serve static assets and proxy /api/* to the Railway backend.
 *
 * Set the RAILWAY_BACKEND_URL environment variable in wrangler.jsonc or via
 * `wrangler secret put RAILWAY_BACKEND_URL` to your Railway deploy URL
 * (e.g. https://your-app.up.railway.app). Without it, /api/* returns 503.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      return proxyToBackend(request, url, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function proxyToBackend(request, url, env) {
  const backend = (env.RAILWAY_BACKEND_URL || "").replace(/\/+$/, "");
  if (!backend) {
    return new Response(
      JSON.stringify({ error: "RAILWAY_BACKEND_URL not configured" }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, X-Samsel-Automix-Token, X-Samsel-Session, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const target = backend + url.pathname + url.search;
  const proxyHeaders = new Headers(request.headers);
  proxyHeaders.set("X-Forwarded-Host", url.hostname);
  proxyHeaders.set("X-Forwarded-Proto", url.protocol.replace(":", ""));

  try {
    const resp = await fetch(target, {
      method: request.method,
      headers: proxyHeaders,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
      redirect: "follow",
    });

    const responseHeaders = new Headers(resp.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.delete("Set-Cookie");

    if (url.pathname.startsWith("/api/jingle/") || url.pathname === "/api/health") {
      responseHeaders.set(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, max-age=0"
      );
      responseHeaders.set("Pragma", "no-cache");
    }

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Backend unreachable", detail: err.message }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}
