#!/usr/bin/env node
/**
 * Web-Check API Health & Effects Validator
 * Tests all 34 endpoints, reports failures, suggests fixes
 * Usage: node health-check.js [base-url] [target-url]
 */

import http from 'http';

const BASE_URL = process.argv[2] || 'http://localhost:3000';
const TARGET = process.argv[3] || 'https://example.com';
const TIMEOUT = 30000;

// The 34 web-check API endpoints (matches the handlers in api/)
const ENDPOINT_NAMES = [
  'archives',
  'block-lists',
  'carbon',
  'cookies',
  'dns',
  'dns-server',
  'dnssec',
  'firewall',
  'get-ip',
  'headers',
  'hsts',
  'http-security',
  'linked-pages',
  'location',
  'mail-config',
  'ports',
  'quality',
  'rank',
  'redirects',
  'robots-txt',
  'screenshot',
  'security-txt',
  'shodan',
  'sitemap',
  'social-tags',
  'ssl',
  'status',
  'subdomains',
  'tech-stack',
  'threats',
  'tls-connection',
  'tls-labs',
  'trace-route',
  'txt-records',
  'whois',
];

const ENDPOINTS = ENDPOINT_NAMES.map((name) => ({
  path: `/api/${name}`,
  method: 'GET',
  params: `?url=${encodeURIComponent(TARGET)}`,
}));

const results = {
  passed: [],
  failed: [],
  skipped: [],
  startTime: Date.now(),
};

function testEndpoint(endpoint) {
  return new Promise((resolve) => {
    const url = `${BASE_URL}${endpoint.path}${endpoint.params || ''}`;
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const req = http.get(url, { timeout: TIMEOUT }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        const status = res.statusCode;
        let body = {};
        try {
          body = JSON.parse(data);
        } catch {
          /* non-JSON body */
        }

        if ((status === 200 || status === 202) && !body.error) {
          const note = body.skipped ? ` (skipped: ${body.skipped.slice(0, 60)})` : '';
          results.passed.push({ ...endpoint, status, responseSize: data.length });
          console.log(`  ✅ ${endpoint.path} — ${status} (${data.length} bytes)${note}`);
        } else if (status >= 500 || body.error) {
          const error = body.error || `Server error ${status}`;
          results.failed.push({ ...endpoint, status, error, data: data.slice(0, 500) });
          console.log(`  ❌ ${endpoint.path} — ${status} (${error.slice(0, 80)})`);
        } else {
          results.skipped.push({ ...endpoint, status, note: 'Client error - may need valid params' });
          console.log(`  ⚠️  ${endpoint.path} — ${status} (client error - check params)`);
        }
        done();
      });
    });

    req.on('error', (err) => {
      if (settled) return;
      results.failed.push({ ...endpoint, status: 0, error: err.message });
      console.log(`  ❌ ${endpoint.path} — ERROR: ${err.message}`);
      done();
    });

    req.on('timeout', () => {
      req.destroy();
      if (settled) return;
      results.failed.push({ ...endpoint, status: 0, error: 'Timeout' });
      console.log(`  ❌ ${endpoint.path} — TIMEOUT`);
      done();
    });
  });
}

async function runHealthCheck() {
  console.log('\n🩺  Web-Check API Health Check');
  console.log(`   Target: ${BASE_URL} (scanning ${TARGET})`);
  console.log(`   Endpoints: ${ENDPOINTS.length}`);
  console.log(`   Timeout: ${TIMEOUT}ms\n`);

  // First check if server is up
  try {
    await new Promise((resolve, reject) => {
      http.get(BASE_URL, { timeout: 5000 }, (res) => {
        console.log(`   Server responding: HTTP ${res.statusCode}\n`);
        res.resume();
        resolve();
      }).on('error', reject);
    });
  } catch (err) {
    console.error(`\n❌  Cannot connect to ${BASE_URL}`);
    console.error(`   Error: ${err.message}`);
    console.error(`\n   Fix: Ensure "yarn start" is running and the server is on port 3000.\n`);
    process.exit(1);
  }

  // Test all endpoints sequentially to avoid overwhelming the server
  for (const endpoint of ENDPOINTS) {
    await testEndpoint(endpoint);
  }

  const duration = Date.now() - results.startTime;

  console.log(`\n📊  Results (${duration}ms)`);
  console.log(`   ✅ Passed:  ${results.passed.length}`);
  console.log(`   ⚠️  Skipped: ${results.skipped.length}`);
  console.log(`   ❌ Failed:  ${results.failed.length}`);

  if (results.failed.length > 0) {
    console.log(`\n🔴  FAILED ENDPOINTS — These need fixes:`);
    results.failed.forEach((f) => {
      console.log(`\n   ${f.path}`);
      console.log(`      Status: ${f.status || 'NETWORK ERROR'}`);
      console.log(`      Error:  ${f.error}`);
      if (f.data) console.log(`      Response preview: ${f.data.substring(0, 200)}...`);
    });
  }

  if (results.skipped.length > 0) {
    console.log(`\n🟡  CLIENT ERRORS — May need real URL params or API keys:`);
    results.skipped.forEach((s) => {
      console.log(`   ${s.path} — ${s.status} (${s.note})`);
    });
  }

  process.exit(results.failed.length > 0 ? 1 : 0);
}

runHealthCheck();
