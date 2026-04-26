export interface CampaignSummary {
  campaign_id: string;
  campaign_name: string;
  role: string | null;
  state: string | null;
  state_override: string | null;
  demand_constraint: string | null;
  measurement_flag: string | null;
  spend_28d: string;
  conversions_28d: string;
  cpa_28d: string | null;
  ctr_28d: string | null;
  lost_is_budget_28d: string | null;
  lost_is_rank_28d: string | null;
  abs_top_is_28d: string | null;
  target_cpa: string | null;
  bid_strategy_type: string | null;
  snapshot_date: string;
}

export interface DashboardSummary {
  total_campaigns: number;
  campaigns_by_state: Record<string, number>;
  measurement_flag: string;
  measurement_reasons: string[];
  data_freshness: string | null;
  pending_decisions: number;
  accounts: { customer_id: string; campaign_count: number }[];
}

export interface SearchTermSummary {
  id: number;
  search_term: string;
  campaign_id: string;
  cost: string;
  clicks: number;
  conversions: string;
  cpa: string | null;
  brand_class: string | null;
  intent_class: string | null;
  move: string | null;
  analyst_decision: string | null;
  snapshot_date: string;
}

export interface AdDiagnosisSummary {
  id: number;
  ad_id: string;
  campaign_id: string;
  impressions: number;
  ctr: string | null;
  cvr: string | null;
  ad_strength: string | null;
  diagnosis: string | null;
  recommended_action: string | null;
  snapshot_date: string;
}

export interface BidBudgetSummary {
  id: number;
  campaign_id: string;
  current_strategy: string | null;
  recommended_strategy: string | null;
  current_target: string | null;
  recommended_target: string | null;
  change_pct: string | null;
  rationale: string | null;
  governance_freeze_until: string | null;
  analyst_decision: string | null;
  snapshot_date: string;
}

export interface CronJob {
  job_id: string;
  mode: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  completed_steps: string[];
  error: string | null;
}
