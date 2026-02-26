export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = new URL(env.SERVER_URL);
    target.pathname = "/api/stream";
    target.search = url.search;

    const nodeRes = await fetch(target.toString(), {
      method: "GET",
      headers: request.headers
    });

    const headers = new Headers(nodeRes.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Headers", "*");

    return new Response(nodeRes.body, {
      status: nodeRes.status,
      headers
    });
  }
};
