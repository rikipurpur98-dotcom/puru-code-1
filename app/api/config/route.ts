import { NextRequest, NextResponse } from "next/server";
import { setWebhook } from "@/lib/telegram";
import { saveConfig } from "@/lib/firebase";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { botId, token, baseUrl, trigger, command, systemPrompt } = body;

    if (!botId || !token || !baseUrl || !systemPrompt) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Determine the webhook URL
    const host = req.headers.get("host");
    const protocol = req.headers.get("x-forwarded-proto") || "https";
    const webhookUrl = `${protocol}://${host}/api/webhook?botId=${botId}`;

    // 1. Set Telegram Webhook
    await setWebhook(token, webhookUrl);

    // 2. Save Configuration to Firebase
    await saveConfig(botId, {
      token,
      baseUrl,
      trigger,
      command,
      systemPrompt,
    });

    return NextResponse.json({ success: true, message: "Configuration saved and webhook set successfully" });
  } catch (error: unknown) {
    console.error("Config API Error:", error);
    let errorMessage = "Internal Server Error";
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === "object" && error !== null && "response" in error) {
      const response = (error as { response?: { data?: { description?: string; error?: string } } }).response;
      errorMessage = response?.data?.description || response?.data?.error || errorMessage;
    }
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
