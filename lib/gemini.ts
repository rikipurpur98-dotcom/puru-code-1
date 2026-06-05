import axios from "axios";

export async function callGeminiAPI(prompt: string, baseUrl: string) {
  try {
    // Try v2 first
    const response = await axios.post(`${baseUrl}/api/ai/gemini-v2`, {
      prompt: prompt,
    });
    return response.data;
  } catch {
    console.log("Gemini v2 failed, falling back to v1...");
    try {
      // Fallback to v1
      const response = await axios.post(`${baseUrl}/api/ai/gemini`, {
        prompt: prompt,
      });
      return response.data;
    } catch (v1Error: unknown) {
      console.error("Gemini v1 also failed:", v1Error instanceof Error ? v1Error.message : "Unknown error");
      throw v1Error;
    }
  }
}

export function parseXmlSafe(xmlString: string, tag: string): string {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = xmlString.match(regex);
  return match ? match[1].trim() : xmlString.trim();
}
