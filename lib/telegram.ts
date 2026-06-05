import axios from "axios";

const TELEGRAM_API = "https://api.telegram.org/bot";

export async function setWebhook(token: string, url: string) {
  try {
    const response = await axios.post(`${TELEGRAM_API}${token}/setWebhook`, {
      url: url,
    });
    return response.data;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Error setting Telegram webhook:", errorMessage);
    throw error;
  }
}

export async function sendMessage(token: string, chatId: string | number, text: string) {
  try {
    const response = await axios.post(`${TELEGRAM_API}${token}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
    });
    return response.data;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Error sending Telegram message:", errorMessage);
    throw error;
  }
}
