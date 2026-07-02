import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { Resend } from "resend";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/plugins/:id/report — submit an anonymous report.
 * Body: { reason: string }
 * Sends an email to the configured REPORT_EMAIL via Resend.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const supabase = await createServerSupabase();
    const { reason } = await request.json();

    if (!reason || reason.trim().length === 0) {
      return NextResponse.json(
        { error: "reason is required" },
        { status: 400 },
      );
    }

    // Resolve plugin by slug or UUID
    let { data: plugin } = await supabase
      .from("plugins")
      .select("id, display_name, slug")
      .eq("slug", id)
      .single();

    if (!plugin) {
      const { data: fallback } = await supabase
        .from("plugins")
        .select("id, display_name, slug")
        .eq("id", id)
        .single();
      plugin = fallback ?? null;
    }

    if (!plugin) {
      return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
    }

    const pluginUuid = plugin.id;

    // Store the report
    const { error: insertError } = await supabase
      .from("plugin_reports")
      .insert({
        plugin_id: pluginUuid,
        reason: reason.trim(),
        reporter_ip: request.headers.get("x-forwarded-for") ?? null,
      });

    if (insertError) {
      return NextResponse.json(
        { error: insertError.message },
        { status: 500 },
      );
    }

    // Send email notification via Resend
    const resendApiKey = process.env.RESEND_API_KEY;
    const reportEmail = process.env.REPORT_EMAIL;

    if (resendApiKey && reportEmail) {
      try {
        const resend = new Resend(resendApiKey);
        await resend.emails.send({
          from: "kern registry <reports@aaenz.no>",
          to: reportEmail,
          subject: `[kern] Plugin reported: ${plugin.display_name}`,
          html: `
            <h2>Plugin Report</h2>
            <p><strong>Plugin:</strong> ${plugin.display_name} (${plugin.slug})</p>
            <p><strong>Reason:</strong> ${reason.trim()}</p>
            <p><strong>Time:</strong> ${new Date().toISOString()}</p>
            <p><a href="${process.env.NEXT_PUBLIC_SITE_URL ?? "https://kern.aaenz.no"}/plugins/${plugin.slug}">View plugin ↗</a></p>
          `,
        });
      } catch (emailErr) {
        // Don't fail the request if email fails
        console.error("Failed to send report email:", emailErr);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("POST /api/plugins/[id]/report error:", err);
    return NextResponse.json(
      { error: "Failed to submit report" },
      { status: 500 },
    );
  }
}
