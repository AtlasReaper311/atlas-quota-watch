/** Atlas Systems /_meta convention. */
export function handleMeta(url, meta) {
  const path = url.pathname;
  if (path !== "/_meta" && !path.endsWith("/_meta")) return null;
  return Response.json(
    { status: "live", ...meta },
    {
      headers: {
        "cache-control": "public, max-age=60",
        "access-control-allow-origin": "*",
      },
    },
  );
}
