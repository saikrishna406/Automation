import OpenAI from 'openai';
import { config } from '../config';
import { JobInput, ScriptResult } from '../types';

const client = new OpenAI({ apiKey: config.openai.apiKey });

const PROMPT_VERSION = 'v1.0';

const SYSTEM_PROMPT = `You are a professional video script writer. Generate structured, engaging scripts for AI avatar videos.
Always return valid JSON matching the schema provided.
Keep language natural for spoken delivery — no markdown, no bullet points, no headers.
Each sentence should flow naturally when read aloud.`;

export async function generateScript(input: JobInput): Promise<ScriptResult> {
  const durationTarget = input.durationTargetSec ?? 90;
  const approxWords = Math.round((durationTarget / 60) * 140); // ~140 wpm

  const userPrompt = `
Generate a video script with these parameters:
- Topic: ${input.topic}
- Tone: ${input.tone}
- Target duration: ${durationTarget} seconds (~${approxWords} words)
- Call to action: ${input.cta ?? 'none'}
- Brand voice: ${input.brandVoice ?? 'professional and concise'}

Return JSON with this exact schema:
{
  "fullText": "complete script as a single string for TTS",
  "sections": [
    { "type": "hook", "text": "...", "approxSec": 10 },
    { "type": "body", "text": "...", "approxSec": 65 },
    { "type": "cta", "text": "...", "approxSec": 15 }
  ],
  "wordCount": 210,
  "estimatedDurationSec": 90
}

Section types to use: hook, body, cta, intro, outro (mix as needed).
The fullText must be the concatenation of all section texts.`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 2000,
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error('OpenAI returned empty content');

  const parsed = JSON.parse(raw);

  // Validate required fields
  if (!parsed.fullText || !Array.isArray(parsed.sections)) {
    throw new Error(`Invalid script structure from OpenAI: ${raw.substring(0, 200)}`);
  }

  return {
    fullText: parsed.fullText,
    sections: parsed.sections,
    wordCount: parsed.wordCount ?? parsed.fullText.split(' ').length,
    estimatedDurationSec: parsed.estimatedDurationSec ?? durationTarget,
    tokensUsed: response.usage?.total_tokens ?? 0,
    promptVersion: PROMPT_VERSION,
  };
}
