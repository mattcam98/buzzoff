/**
 * Question content. Content is deliberately free of gameplay rules: a pack is
 * a pool of trivia categories and survey questions that any ruleset can draw
 * from, so the same pack can back a quick 4x4 board or a full two-round show.
 */
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().trim().min(1).max(40);

/** Media is either an upload served by this server or an absolute http(s) URL. */
const isSafeMediaUrl = (url: string) => /^\/media\/[\w.-]+$/.test(url) || /^https?:\/\/[^\s]+$/i.test(url);

export const MediaSchema = z.object({
  kind: z.enum(['image', 'audio', 'video']),
  url: z.string().max(2000).refine(isSafeMediaUrl, 'Media must be an uploaded file or an http(s) URL'),
});

export const ClueSchema = z.object({
  id,
  /** Base point value; a round's multiplier is applied on top. */
  value: z.number().int().min(0).max(1_000_000),
  /** 1 (easiest) to 5 (hardest). Informational, shown to the host and editor. */
  difficulty: z.number().int().min(1).max(5).optional(),
  question: text(600),
  answer: text(300),
  /** Other answers the host should accept. Shown to the host while judging. */
  accept: z.array(text(200)).max(20).default([]),
  /** Private host notes, e.g. pronunciation or a fun fact to read out. */
  notes: z.string().trim().max(600).optional(),
  media: MediaSchema.optional(),
});

export const CategorySchema = z.object({
  id,
  title: text(60),
  blurb: z.string().trim().max(160).optional(),
  /** Either/or categories: only the first buzzer may answer, with no steals. */
  singleAttempt: z.boolean().optional(),
  clues: z.array(ClueSchema).min(1).max(10),
});

export const SurveyAnswerSchema = z.object({
  text: text(80),
  points: z.number().int().min(0).max(1000),
  /** Equivalent phrasings that should score as this answer. */
  aliases: z.array(text(80)).max(30).default([]),
});

export const SurveySchema = z.object({
  id,
  question: text(240),
  answers: z.array(SurveyAnswerSchema).min(1).max(12),
});

const unique = (items: { id: string }[]) => new Set(items.map((x) => x.id)).size === items.length;

export const PackContentSchema = z.object({
  title: text(80),
  description: z.string().trim().max(400).default(''),
  author: z.string().trim().max(80).default(''),
  // Games tell categories and surveys apart by id, so ids must not repeat within a pack.
  categories: z.array(CategorySchema).max(80).default([]).refine(unique, 'Two categories share the same id'),
  surveys: z.array(SurveySchema).max(80).default([]).refine(unique, 'Two surveys share the same id'),
});

export const PackSchema = PackContentSchema.extend({
  id,
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** Portable import/export envelope. */
export const PackFileSchema = z.object({
  format: z.literal('buzzoff.pack'),
  version: z.literal(1),
  pack: PackContentSchema,
});

export type Media = z.infer<typeof MediaSchema>;
export type Clue = z.infer<typeof ClueSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type SurveyAnswer = z.infer<typeof SurveyAnswerSchema>;
export type Survey = z.infer<typeof SurveySchema>;
export type PackContent = z.infer<typeof PackContentSchema>;
export type Pack = z.infer<typeof PackSchema>;
export type PackFile = z.infer<typeof PackFileSchema>;

export interface PackSummary {
  id: string;
  title: string;
  description: string;
  author: string;
  categoryCount: number;
  clueCount: number;
  surveyCount: number;
  updatedAt: number;
}

export const summarizePack = (p: Pack): PackSummary => ({
  id: p.id,
  title: p.title,
  description: p.description,
  author: p.author,
  categoryCount: p.categories.length,
  clueCount: p.categories.reduce((n, c) => n + c.clues.length, 0),
  surveyCount: p.surveys.length,
  updatedAt: p.updatedAt,
});
