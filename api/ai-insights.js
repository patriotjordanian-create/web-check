import middleware from './_common/middleware.js';
import { UA } from './_common/http.js';
import { requireEnv } from './_common/upstream.js';
import { createLogger } from './_common/logger.js';

const log = createLogger('ai-insights');

const FETCH_TIMEOUT = 8000;
// Cap the HTML snapshot so prompts stay small and well under the request timeout
const MAX_HTML_CHARS = 15000;
const CLAUDE_MODEL = 'claude-opus-4-8';

// Claude Platform on AWS (aws-external-anthropic) config. AWS_REGION must be the
// region the workspace is bound to. Auth is either ANTHROPIC_AWS_API_KEY (generated
// in the AWS Console) or SigV4 via the default AWS credential provider chain.
const requireClaudeConfig = () => {
  const workspace = requireEnv('ANTHROPIC_AWS_WORKSPACE_ID', 'AI insights');
  if (workspace.skipped) return workspace;
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (!region) return { skipped: 'AI insights requires AWS_REGION to be set' };
  return {};
};

// Grab a lightweight snapshot of the site (headers + truncated HTML) to analyse
const fetchSiteSnapshot = async (url) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    redirect: 'follow',
    headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.1' },
  });
  const headers = Object.fromEntries(res.headers.entries());
  const html = (await res.text()).slice(0, MAX_HTML_CHARS);
  return { status: res.status, finalUrl: res.url, headers, html };
};

const INSIGHTS_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description:
        'Two to three sentence plain-language overview of the site and its security posture',
    },
    securityFindings: {
      type: 'array',
      description: 'Notable security observations, most important first',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'low', 'medium', 'high'] },
          detail: { type: 'string' },
        },
        required: ['title', 'severity', 'detail'],
        additionalProperties: false,
      },
    },
    recommendations: {
      type: 'array',
      description: 'Concrete, actionable improvements for the site owner',
      items: { type: 'string' },
    },
  },
  required: ['summary', 'securityFindings', 'recommendations'],
  additionalProperties: false,
};

const buildPrompt = ({ status, finalUrl, headers, html }, url) =>
  'You are a web security analyst reviewing a public website snapshot gathered by ' +
  'Web-Check (an OSINT tool). Assess the HTTP response headers and HTML excerpt below. ' +
  'Focus on security headers (CSP, HSTS, X-Frame-Options, etc.), information leakage ' +
  '(server banners, framework hints), and anything notable in the markup. Only report ' +
  'what the data supports - do not speculate beyond it.\n\n' +
  `Requested URL: ${url}\n` +
  `Final URL after redirects: ${finalUrl}\n` +
  `HTTP status: ${status}\n\n` +
  `Response headers:\n${JSON.stringify(headers, null, 2)}\n\n` +
  `HTML excerpt (first ${MAX_HTML_CHARS} chars):\n${html}`;

// AI-generated summary of a site's security posture, powered by Claude running on
// Claude Platform on AWS. Skips cleanly when the platform env vars are not set.
const aiInsightsHandler = async (url) => {
  const config = requireClaudeConfig();
  if (config.skipped) return config;

  let snapshot;
  try {
    snapshot = await fetchSiteSnapshot(url);
  } catch (error) {
    log.warn(`snapshot fetch failed for ${url}`, error.message);
    return { error: `Failed to fetch site: ${error.message}` };
  }

  // Imported lazily so instances without the platform configured never load the SDK
  const { default: AnthropicAws } = await import('@anthropic-ai/aws-sdk');
  const client = new AnthropicAws();

  try {
    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      // Low effort keeps latency inside the API timeout; the task is a bounded summary
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: INSIGHTS_SCHEMA },
      },
      messages: [{ role: 'user', content: buildPrompt(snapshot, url) }],
    });

    if (response.stop_reason === 'refusal') {
      return { skipped: 'The AI model declined to analyse this site' };
    }
    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock) {
      return { error: 'AI response contained no analysis' };
    }
    return {
      model: response.model,
      analysedUrl: snapshot.finalUrl,
      ...JSON.parse(textBlock.text),
    };
  } catch (error) {
    log.warn(`Claude request failed for ${url}`, error.message);
    if (error.status === 401 || error.status === 403) {
      return { error: 'Claude Platform on AWS rejected the credentials or workspace ID' };
    }
    if (error.status === 429) {
      return { error: 'AI insights rate-limited by Claude Platform on AWS' };
    }
    return { error: `AI analysis failed: ${error.message}` };
  }
};

export const handler = middleware(aiInsightsHandler);
export default handler;
