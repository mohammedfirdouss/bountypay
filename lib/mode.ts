export type Mode = "live" | "demo" | "offline";

/**
 * From BOUNTYPAY_DEMO. "1" is demo: GitHub reads come from demo/fixtures.json and comments are logged.
 * "offline" is demo plus built-in stand-ins for Claude and PayPal, so it needs no keys. Anything else is live.
 */
export function mode(): Mode {
  const v = process.env.BOUNTYPAY_DEMO;
  return v === "offline" ? "offline" : v === "1" ? "demo" : "live";
}
