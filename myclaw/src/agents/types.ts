/**
 * Agent System Types
 * Agent → Skills → Tools (3 ชั้น)
 */

export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  provider: string;       // gemini, anthropic, openai, ollama
  model: string;          // gemini-2.5-flash, claude-sonnet-4, gpt-4o, glm-4.7-flash
  apiKey: string | null;  // per-agent API key (null = ใช้จาก env)
  systemPrompt: string | null; // null = ใช้ default prompt
  enabled: boolean;
  isDefault: boolean;
  skills?: SkillConfig[];      // populated by join
  createdAt: string;
  updatedAt: string;
}

export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  promptHint: string | null;   // เพิ่มเข้า system prompt เมื่อ skill ถูกเลือก
  tools: string[];             // tool names: ["web_search","web_fetch"]
  toolType: "ai" | "non-ai";
  keywords: string[];          // สำหรับ matching: ["ค้นหา","search","หา"]
  createdAt: string;
}

export interface AgentSkillLink {
  agentId: string;
  skillId: string;
  priority: number;            // สูง = ถนัดมาก
}

export interface RecommendResult {
  agent: AgentConfig;
  skill: SkillConfig | null;
  reason: string;
}
