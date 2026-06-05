"use client";

import React, { useState } from "react";
import axios from "axios";

export default function ConfigPage() {
  const [formData, setFormData] = useState({
    botId: "",
    token: "",
    baseUrl: "",
    trigger: "all",
    command: "",
    systemPrompt: "",
  });

  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setStatus(null);

    try {
      const response = await axios.post("/api/config", formData);
      if (response.data.success) {
        setStatus({ type: "success", message: "Konfigurasi berhasil disimpan dan webhook telah diatur!" });
      } else {
        setStatus({ type: "error", message: "Gagal menyimpan konfigurasi." });
      }
    } catch (error: unknown) {
      let errorMessage = "Terjadi kesalahan saat menyimpan konfigurasi.";
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === "object" && error !== null && "response" in error) {
        const response = (error as { response?: { data?: { error?: string } } }).response;
        errorMessage = response?.data?.error || errorMessage;
      }
      setStatus({
        type: "error",
        message: errorMessage
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md mx-auto bg-slate-900 rounded-xl shadow-2xl overflow-hidden md:max-w-2xl p-6 border border-slate-800">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-slate-50">Bot Configuration</h1>
          <p className="text-slate-400">Atur konfigurasi bot Telegram Anda di sini</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300">Bot ID</label>
            <input
              type="text"
              name="botId"
              value={formData.botId}
              onChange={handleChange}
              className="mt-1 block w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-sm text-slate-200 shadow-sm placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
              placeholder="Contoh: my-awesome-bot"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300">Telegram Token</label>
            <input
              type="password"
              name="token"
              value={formData.token}
              onChange={handleChange}
              className="mt-1 block w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-sm text-slate-200 shadow-sm placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
              placeholder="123456789:ABCdefGhI..."
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300">Gemini Base URL</label>
            <input
              type="url"
              name="baseUrl"
              value={formData.baseUrl}
              onChange={handleChange}
              className="mt-1 block w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-sm text-slate-200 shadow-sm placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
              placeholder="https://your-api-domain.com"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300">Trigger Type</label>
              <select
                name="trigger"
                value={formData.trigger}
                onChange={handleChange}
                className="mt-1 block w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-sm text-slate-200 shadow-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
              >
                <option value="all">All Messages</option>
                <option value="command">Command</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300">Command</label>
              <input
                type="text"
                name="command"
                value={formData.command}
                onChange={handleChange}
                disabled={formData.trigger === "all"}
                className={`mt-1 block w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-sm text-slate-200 shadow-sm placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all ${formData.trigger === "all" ? "bg-slate-800 cursor-not-allowed" : ""}`}
                placeholder="/start"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300">System Prompt</label>
            <textarea
              name="systemPrompt"
              rows={4}
              value={formData.systemPrompt}
              onChange={handleChange}
              className="mt-1 block w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-md text-sm text-slate-200 shadow-sm placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
              placeholder="Anda adalah asisten yang membantu..."
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className={`w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white ${loading ? "bg-indigo-400" : "bg-indigo-600 hover:bg-indigo-700"} focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors`}
          >
            {loading ? "Saving..." : "Save Configuration"}
          </button>
        </form>

        {status && (
          <div className={`mt-4 p-3 rounded-md text-sm text-center ${status.type === "success" ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"}`}>
            {status.message}
          </div>
        )}
      </div>
    </div>
  );
}
