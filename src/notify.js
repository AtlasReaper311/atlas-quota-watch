/** Send one Atlas notification without allowing alert delivery to break the check. */
export async function notify(env, event) {
  if (!env.NOTIFY_TOKEN) {
    console.log("notify: NOTIFY_TOKEN not set; skipping");
    return false;
  }

  const body = {
    source: "alert",
    signal_class: env.NOTIFY_SIGNAL_CLASS || undefined,
    level: event.level,
    title: event.title,
    message: event.message,
    fields: event.fields,
  };
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }

  const init = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.NOTIFY_TOKEN}`,
    },
    body: JSON.stringify(body),
  };

  try {
    const response = env.ATLAS_NOTIFY
      ? await env.ATLAS_NOTIFY.fetch("https://atlas-notify/notify", init)
      : env.NOTIFY_URL
        ? await fetch(env.NOTIFY_URL, init)
        : null;
    if (!response) {
      console.log("notify: no ATLAS_NOTIFY binding or NOTIFY_URL");
      return false;
    }
    console.log("notify: status", response.status, "title:", event.title);
    return response.ok;
  } catch (error) {
    console.log("notify failed:", error.message);
    return false;
  }
}
