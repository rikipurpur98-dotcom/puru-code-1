import { NextRequest, NextResponse } from "next/server";
import { getConfig, saveHistory, getHistory, ChatMessage } from "@/lib/firebase";
import { sendMessage } from "@/lib/telegram";
import { callGeminiAPI, parseXmlSafe } from "@/lib/gemini";

export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const botId = searchParams.get("botId");

    if (!botId) {
      return NextResponse.json({ error: "botId is required" }, { status: 400 });
    }

    // 1. Get Bot Configuration
    const config = await getConfig(botId);
    if (!config) {
      return NextResponse.json({ error: "Bot configuration not found" }, { status: 404 });
    }

    const update = await req.json();
    const message = update.message;

    if (!message || !message.text) {
      return NextResponse.json({ success: true }); // Ignore non-text messages
    }

    const chatId = message.chat.id;
    const userText = message.text;

    // 2. Validate Trigger
    if (config.trigger === "command") {
      if (!userText.startsWith(config.command)) {
        return NextResponse.json({ success: true }); // Ignore if not the command
      }
    }

    // 3. Manage Chat History
    const history = await getHistory(botId, chatId.toString());
    
    // Construct prompt with history
    let prompt = `System Prompt: ${config.systemPrompt}\n\n`;
    
    history.forEach((msg: ChatMessage) => {
      prompt += `User: ${msg.user}\nAI: ${msg.ai}\n\n`;
    });
    
    prompt += `User: ${userText}\nAI:`;

    // 4. Call Gemini AI
    const aiResponseRaw = await callGeminiAPI(prompt, config.baseUrl);
    const aiResponse = parseXmlSafe(aiResponseRaw, "response");

    // 5. Save to History
    await saveHistory(botId, chatId.toString(), {
      user: userText,
      ai: aiResponse,
      timestamp: new Date().toISOString(),
    });

    // 6. Send Reply to Telegram
    await sendMessage(config.token, chatId, aiResponse);

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error("Webhook Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
