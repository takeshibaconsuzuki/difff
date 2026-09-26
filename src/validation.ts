import { z } from 'zod';

export const scopeSchema = z.enum(['uncommitted', 'staged', 'unstaged']);
export const commentSchema = z.object({
  id: z.string(),
  repository: z.string(),
  path: z.string(),
  scope: scopeSchema,
  side: z.enum(['old', 'new']),
  line: z.number().int().positive(),
  code: z.string(),
  body: z.string().min(1).max(20000),
  createdAt: z.string(),
});

const anchorSchema = z.object({
  path: z.string(),
  side: z.enum(['old', 'new']),
  line: z.number().int().positive(),
});

export const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), scope: scopeSchema.optional(), repository: z.string().optional() }),
  z.object({ type: z.literal('refresh') }),
  z.object({ type: z.literal('scope'), scope: scopeSchema }),
  z.object({ type: z.literal('repository'), root: z.string() }),
  z.object({ type: z.literal('expand'), path: z.string(), snapshot: z.string(), gap: z.string(), direction: z.enum(['up', 'down']) }),
  z.object({ type: z.literal('expandAll'), path: z.string(), snapshot: z.string() }),
  anchorSchema.extend({ type: z.literal('comment'), body: z.string().trim().min(1).max(20000), code: z.string(), scope: scopeSchema, repository: z.string() }),
  z.object({ type: z.literal('edit'), id: z.string(), body: z.string().trim().min(1).max(20000) }),
  z.object({ type: z.literal('delete'), id: z.string() }),
  z.object({ type: z.literal('clear') }),
  z.object({ type: z.literal('copy') }),
  z.object({ type: z.literal('jump'), id: z.string() }),
  anchorSchema.omit({ side: true }).extend({ type: z.literal('open') }),
]);
