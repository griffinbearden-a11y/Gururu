import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const articles = defineCollection({
  loader: glob({ pattern: '**/*.md', base: 'content/articles' }),
  schema: z.object({
    writer: z.enum(['wolf', 'vail', 'doyle']),
    title: z.string(),
    format: z.string(),
    subject_teams: z.array(z.number()).default([]),
    subject_players: z.array(z.string()).default([]),
    thesis: z.string(),
    published: z.boolean().default(true),
    is_backfill: z.boolean().default(false),
    created_at: z.coerce.date(),
  }),
});

export const collections = { articles };
