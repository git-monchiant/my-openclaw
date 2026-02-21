import type { ToolDefinition } from "./types.js";
import { datetimeTool } from "./datetime.js";

/**
 * Tool Registry
 *
 * เพิ่ม tool ใหม่ 3 ขั้นตอน:
 * 1. สร้างไฟล์ใน src/tools/ (implement ToolDefinition)
 * 2. import เข้ามาที่นี่
 * 3. เพิ่มใน array ข้างล่าง
 */
const allTools: ToolDefinition[] = [
  datetimeTool,
  // เพิ่ม tool ใหม่ตรงนี้:
  // webSearchTool,
  // execTool,
  // readFileTool,
];

// หา tool จากชื่อ
export function findTool(name: string): ToolDefinition | undefined {
  return allTools.find((t) => t.name === name);
}

// แปลง tools เป็น format ที่ Claude API ต้องการ
export function getToolDefinitions() {
  return allTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

// รัน tool ตามชื่อ
export async function executeTool(
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  const tool = findTool(name);
  if (!tool) {
    return `Error: tool "${name}" not found`;
  }
  try {
    return await tool.execute(input);
  } catch (err) {
    return `Error executing ${name}: ${err}`;
  }
}

export type { ToolDefinition } from "./types.js";
