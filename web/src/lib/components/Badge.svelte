<script lang="ts">
  const TONES: Record<string, string> = {
    draft: "neutral",
    issued: "info",
    approved: "info",
    recorded: "info",
    posted: "success",
    paid: "success",
    sent: "success",
    matched: "success",
    filed: "success",
    partial: "warning",
    unpaid: "warning",
    unmatched: "warning",
    queued: "warning",
    void: "danger",
    ignored: "neutral",
  };
  const LABELS: Record<string, string> = {
    draft: "Draf",
    issued: "Terbit",
    approved: "Disetujui",
    recorded: "Tercatat",
    posted: "Terposting",
    paid: "Lunas",
    partial: "Sebagian",
    unpaid: "Belum dibayar",
    void: "Batal",
    sent: "Terkirim",
    queued: "Antri",
    matched: "Cocok",
    unmatched: "Belum cocok",
    ignored: "Diabaikan",
    filed: "Dilaporkan",
  };

  let { status }: { status: string } = $props();
</script>

<span class="badge {TONES[status] ?? 'neutral'}">{LABELS[status] ?? status}</span>

<style>
  .badge {
    display: inline-block;
    padding: 0.1rem 0.55rem;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 600;
    white-space: nowrap;
  }
  .neutral {
    background: var(--surface-muted);
    color: var(--text-muted);
  }
  .info {
    background: var(--info-soft);
    color: var(--info);
  }
  .success {
    background: var(--primary-soft);
    color: var(--primary);
  }
  .warning {
    background: var(--warning-soft);
    color: var(--warning);
  }
  .danger {
    background: var(--danger-soft);
    color: var(--danger);
  }
</style>
