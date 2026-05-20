export default async function handler(req, res) {
  const PANEL_URL = "https://control.optiklink.net";
  const SERVER_ID = "12c12c5c";
  const API_KEY = "IobW2sgFacvT0YVuTUtptQ43VTuNWTHUIHXC4L1DjgpHCFYV";

  const headers = {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  try {
    // 1. Cek Status Server
    const statusResponse = await fetch(`${PANEL_URL}/api/client/servers/${SERVER_ID}/resources`, {
      method: 'GET',
      headers: headers
    });

    const data = await statusResponse.json();
    const currentState = data.attributes?.current_state;

    // 2. Logika Pengecekan
    if (currentState === "running") {
      return res.status(200).json({ status: "online", message: "Server sudah menyala." });
    } 
    
    if (currentState === "starting") {
      return res.status(200).json({ status: "starting", message: "Server sedang proses menyala." });
    }

    // 3. Jika offline, kirim perintah START
    const startResponse = await fetch(`${PANEL_URL}/api/client/servers/${SERVER_ID}/power`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ signal: "start" })
    });

    if (startResponse.ok) {
      return res.status(200).json({ 
        status: "action_taken", 
        message: `Server tadi ${currentState}, perintah START telah dikirim.` 
      });
    } else {
      throw new Error("Gagal mengirim perintah start ke panel.");
    }

  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
}
