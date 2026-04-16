/**
 * Reactivate a suspended Wrike webhook.
 * Returns true on success, false on failure (logs the error).
 */
export async function reactivateWebhook(): Promise<boolean> {
  const webhookId = process.env.WRIKE_WEBHOOK_ID;
  const token = process.env.WRIKE_PERMANENT_ACCESS_TOKEN;

  if (!webhookId || !token) {
    console.warn(
      "[wrike] Cannot reactivate webhook — missing WRIKE_WEBHOOK_ID or WRIKE_PERMANENT_ACCESS_TOKEN env var",
    );
    return false;
  }

  try {
    const res = await fetch(
      `https://www.wrike.com/api/v4/webhooks/${webhookId}?status=Active`,
      {
        method: "PUT",
        headers: { Authorization: `bearer ${token}` },
      },
    );

    if (res.ok) {
      console.log(`[wrike] Webhook ${webhookId} reactivated successfully`);
      return true;
    }

    const body = await res.text().catch(() => "");
    console.error(
      `[wrike] Webhook reactivation failed: ${res.status} ${res.statusText}`,
      body,
    );
    return false;
  } catch (err) {
    console.error("[wrike] Webhook reactivation request failed:", err);
    return false;
  }
}
