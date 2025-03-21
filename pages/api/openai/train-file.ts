import type { NextApiRequest, NextApiResponse } from 'next';
import { Project, ProjectChecksums, FileData } from '@/types/types';
import { generateFileEmbeddings } from '@/lib/generate-embeddings';
import { getProjectChecksumsKey, safeGetObject } from '@/lib/redis';
import { createServerSupabaseClient } from '@supabase/auth-helpers-nextjs';
import { Database } from '@/types/supabase';
import {
  checkEmbeddingsRateLimits,
  getEmbeddingsRateLimitResponse,
} from '@/lib/rate-limits';
import { createClient } from '@supabase/supabase-js';
import { createChecksum } from '@/lib/utils';
import { getOpenAIKey } from '@/lib/supabase';

type Data = {
  status?: string;
  error?: string;
  errors?: any[];
};

// Admin access to Supabase, bypassing RLS.
const supabaseAdmin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>,
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  // Admin supabase does not have sesesion data.
  const supabase = createServerSupabaseClient<Database>({ req, res });
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const file = req.body.file as FileData;
  const projectId = req.body.projectId as Project['id'];

  if (!req.body.forceRetrain && projectId) {
    const checksums = await safeGetObject<ProjectChecksums>(
      getProjectChecksumsKey(projectId),
      {},
    );
    const previousChecksum = checksums[file.path];
    const currentChecksum = createChecksum(file.content);
    if (previousChecksum === currentChecksum) {
      return res.status(200).json({ status: 'Already processed' });
    }
  }

  // Apply rate limits
  const rateLimitResult = await checkEmbeddingsRateLimits({
    type: 'projectId',
    value: projectId,
  });

  res.setHeader('X-RateLimit-Limit', rateLimitResult.result.limit);
  res.setHeader('X-RateLimit-Remaining', rateLimitResult.result.remaining);

  if (!rateLimitResult.result.success) {
    console.error(`[TRAIN] [RATE-LIMIT] Project: ${projectId}`);
    return res.status(429).json({
      status: getEmbeddingsRateLimitResponse(
        rateLimitResult.hours,
        rateLimitResult.minutes,
      ),
    });
  }

  const openAIKey = await getOpenAIKey(supabaseAdmin, projectId);

  const errors = await generateFileEmbeddings(
    supabaseAdmin,
    projectId,
    file,
    openAIKey,
  );

  return res.status(200).json({ status: 'ok', errors });
}
