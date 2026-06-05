import { initializeApp, getApp, getApps } from "firebase/app";
import { getDatabase, ref, set, get, push } from "firebase/database";

const firebaseConfig = {
  databaseURL: "https://puruboy-tools-default-rtdb.firebaseio.com",
};

// Initialize Firebase
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const db = getDatabase(app);

export interface BotConfig {
  token: string;
  baseUrl: string;
  trigger?: string;
  command?: string;
  systemPrompt: string;
}

export async function saveConfig(botId: string, config: BotConfig) {
  try {
    await set(ref(db, `configs/${botId}`), config);
    return { success: true };
  } catch (error) {
    console.error("Error saving config:", error);
    throw error;
  }
}

export async function getConfig(botId: string) {
  try {
    const snapshot = await get(ref(db, `configs/${botId}`));
    if (snapshot.exists()) {
      return snapshot.val();
    }
    return null;
  } catch (error) {
    console.error("Error getting config:", error);
    throw error;
  }
}

export interface ChatMessage {
  user: string;
  ai: string;
  timestamp: string;
}

export async function saveHistory(botId: string, chatId: string, message: ChatMessage) {
  try {
    const historyRef = ref(db, `history/${botId}/${chatId}`);
    const newHistoryRef = push(historyRef);
    await set(newHistoryRef, message);
    
    // Limit history to 20 messages
    const snapshot = await get(historyRef);
    if (snapshot.exists()) {
      const data = snapshot.val();
      const keys = Object.keys(data);
      if (keys.length > 20) {
        const toRemove = keys.slice(0, keys.length - 20);
        for (const key of toRemove) {
          await set(ref(db, `history/${botId}/${chatId}/${key}`), null);
        }
      }
    }
    return { success: true };
  } catch (error) {
    console.error("Error saving history:", error);
    throw error;
  }
}

export async function getHistory(botId: string, chatId: string) {
  try {
    const snapshot = await get(ref(db, `history/${botId}/${chatId}`));
    if (snapshot.exists()) {
      return Object.values(snapshot.val());
    }
    return [];
  } catch (error) {
    console.error("Error getting history:", error);
    throw error;
  }
}
