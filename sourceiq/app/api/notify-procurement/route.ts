// POST /api/notify-procurement
// Sends a contextual email to the procurement team when a Decision Queue item is approved.
// Procurement email address is read from config/local.json (no env var needed for demo).
// SMTP credentials come from .env.local (reuses the same nodemailer setup as morning-brief).
import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import nodemailer from 'nodemailer';
import { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } from '../../../src/lib/env';
import type { AgentDecision } from '../../../src/types/index';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface NotifyPayload {
  decision: AgentDecision;
  analysisQuery: string;
  approvedAt: string;
}

interface LocalConfig {
  procurement: {
    email: string;
    teamName: string;
    ccEmails: string[];
  };
  app: {
    name: string;
    baseUrl: string;
  };
}

function loadConfig(): LocalConfig {
  const configPath = join(process.cwd(), 'config', 'local.json');
  return JSON.parse(readFileSync(configPath, 'utf-8')) as LocalConfig;
}

function buildEmailHtml(decision: AgentDecision, config: LocalConfig, approvedAt: string): string {
  const isRisk = decision.type === 'risk';
  const accentColor = decision.severity === 'critical' ? '#ef4444'
    : decision.severity === 'high' ? '#f97316' : '#64748b';
  const badgeColor = decision.severity === 'critical' ? '#7f1d1d'
    : decision.severity === 'high' ? '#7c2d12' : '#1e293b';

  const impactLine = decision.estimatedImpactUSD != null && decision.estimatedImpactUSD > 0
    ? isRisk
      ? `<strong>Estimated exposure:</strong> $${decision.estimatedImpactUSD.toLocaleString()} at risk`
      : `<strong>Estimated savings:</strong> $${decision.estimatedImpactUSD.toLocaleString()}/yr`
    : '';

  const skuLine = decision.sku
    ? `<strong>SKU:</strong> ${decision.sku}<br/>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;color:#e2e8f0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#0f172a;">
    <tr>
      <td style="padding:24px 24px 0;">
        <!-- Header -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding-bottom:20px;border-bottom:1px solid #1e293b;">
              <span style="font-size:18px;font-weight:700;letter-spacing:-0.5px;color:#e2e8f0;">
                SourceIQ
              </span>
              <span style="margin-left:8px;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:1px;">
                Procurement Alert
              </span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 24px;">
        <!-- Severity badge + headline -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
          <tr>
            <td>
              <span style="display:inline-block;background:${badgeColor};color:${accentColor};
                           font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;
                           padding:2px 8px;border-radius:4px;border:1px solid ${accentColor}44;margin-bottom:10px;">
                ${decision.severity} priority · ${decision.type}
              </span>
              <h1 style="margin:0 0 6px;font-size:20px;font-weight:700;color:#f1f5f9;line-height:1.2;">
                ${decision.headline}
              </h1>
              <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.5;">
                ${decision.rationale}
              </p>
            </td>
          </tr>
        </table>

        <!-- Data block -->
        <table width="100%" cellpadding="0" cellspacing="0"
               style="background:#1e293b;border-radius:8px;border:1px solid #334155;margin-bottom:20px;">
          <tr>
            <td style="padding:16px;">
              <p style="margin:0 0 8px;font-size:12px;color:#94a3b8;line-height:1.7;">
                <strong style="color:#e2e8f0;">Country:</strong> ${decision.country}<br/>
                ${skuLine}
                <strong style="color:#e2e8f0;">Urgency score:</strong> ${decision.urgencyScore}/100
                ${decision.sriScore != null ? `<br/><strong style="color:#e2e8f0;">SRI:</strong> ${decision.sriScore}/100` : ''}
                ${impactLine ? `<br/>${impactLine}` : ''}
              </p>
            </td>
          </tr>
        </table>

        <!-- Approved action -->
        <table width="100%" cellpadding="0" cellspacing="0"
               style="background:#0d1f3c;border-radius:8px;border:1px solid #1d4ed8;margin-bottom:20px;">
          <tr>
            <td style="padding:14px 16px;">
              <p style="margin:0 0 4px;font-size:10px;font-weight:700;text-transform:uppercase;
                         letter-spacing:1px;color:#60a5fa;">Approved Analysis Query</p>
              <p style="margin:0;font-size:12px;color:#bfdbfe;font-style:italic;line-height:1.5;">
                "${decision.prebuiltQuery}"
              </p>
            </td>
          </tr>
        </table>

        <!-- What to do -->
        <table width="100%" cellpadding="0" cellspacing="0"
               style="background:#052e16;border-radius:8px;border:1px solid #16a34a;margin-bottom:24px;">
          <tr>
            <td style="padding:14px 16px;">
              <p style="margin:0 0 4px;font-size:10px;font-weight:700;text-transform:uppercase;
                         letter-spacing:1px;color:#4ade80;">Recommended Action</p>
              <p style="margin:0;font-size:12px;color:#86efac;line-height:1.5;">
                ${isRisk
                  ? `Review alternative sourcing countries for <strong>${decision.country}</strong>.
                     ${decision.sku ? `Prioritize SKU <strong>${decision.sku}</strong>.` : ''}
                     Full analysis has been submitted to the SourceIQ agent — results will be available in the chat.`
                  : `Evaluate switching <strong>${decision.sku ?? 'this SKU'}</strong> from
                     <strong>${decision.country}</strong> to a lower-cost supplier country.
                     Estimated annual savings: <strong>$${(decision.estimatedImpactUSD ?? 0).toLocaleString()}</strong>.
                     Full tariff comparison submitted to SourceIQ.`
                }
              </p>
            </td>
          </tr>
        </table>

        <!-- CTA link -->
        <table cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
          <tr>
            <td style="background:#1d4ed8;border-radius:6px;">
              <a href="${config.app.baseUrl}" target="_blank"
                 style="display:inline-block;padding:10px 20px;color:#fff;font-size:13px;
                        font-weight:600;text-decoration:none;letter-spacing:0.2px;">
                Open SourceIQ Dashboard →
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <!-- Footer -->
    <tr>
      <td style="padding:16px 24px 24px;border-top:1px solid #1e293b;">
        <p style="margin:0;font-size:10px;color:#475569;line-height:1.6;">
          This alert was approved in the <strong style="color:#64748b;">SourceIQ Decision Queue</strong>
          at ${new Date(approvedAt).toLocaleString()} and automatically forwarded to ${config.procurement.teamName}.<br/>
          SourceIQ · AI-powered retail sourcing intelligence · On-device inference (phi-4-mini)
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildSubject(decision: AgentDecision): string {
  const prefix = decision.severity === 'critical' ? '[CRITICAL]'
    : decision.severity === 'high' ? '[HIGH PRIORITY]' : '[ACTION REQUIRED]';

  if (decision.type === 'risk') {
    return `${prefix} SourceIQ: Sourcing Risk — ${decision.country} (${decision.sriScore ?? '?'}/100 SRI)`;
  }
  const savings = decision.estimatedImpactUSD != null
    ? ` — $${decision.estimatedImpactUSD.toLocaleString()}/yr savings`
    : '';
  return `${prefix} SourceIQ: Cost Opportunity — ${decision.sku ?? decision.country}${savings}`;
}

export async function POST(request: Request): Promise<NextResponse> {
  let config: LocalConfig;
  try {
    config = loadConfig();
  } catch {
    return NextResponse.json(
      { sent: false, reason: 'config/local.json not found or invalid' },
      { status: 500 },
    );
  }

  const body = await request.json() as Partial<NotifyPayload>;
  const { decision, approvedAt = new Date().toISOString() } = body;

  if (!decision) {
    return NextResponse.json({ sent: false, reason: 'Missing decision payload' }, { status: 400 });
  }

  const toEmail = config.procurement.email;
  const subject = buildSubject(decision);
  const html = buildEmailHtml(decision, config, approvedAt);

  // If SMTP is not configured, log and return success (useful for local demo)
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log('[notify-procurement] SMTP not configured — email simulated:');
    console.log(`  TO: ${toEmail}`);
    console.log(`  SUBJECT: ${subject}`);
    console.log(`  DECISION: ${decision.id} (${decision.type} · ${decision.severity})`);
    return NextResponse.json({
      sent: true,
      simulated: true,
      to: toEmail,
      subject,
      message: 'Email logged (SMTP not configured — set SMTP_* env vars to enable real delivery)',
    });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: parseInt(SMTP_PORT ?? '587', 10),
      secure: parseInt(SMTP_PORT ?? '587', 10) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    const cc = config.procurement.ccEmails.length > 0
      ? config.procurement.ccEmails.join(', ')
      : undefined;

    await transporter.sendMail({
      from: `"SourceIQ Alerts" <${SMTP_USER}>`,
      to: toEmail,
      ...(cc ? { cc } : {}),
      subject,
      html,
    });

    return NextResponse.json({ sent: true, simulated: false, to: toEmail, subject });
  } catch (err) {
    console.error('[notify-procurement] Failed to send email:', err);
    return NextResponse.json(
      { sent: false, reason: (err as Error).message },
      { status: 500 },
    );
  }
}
