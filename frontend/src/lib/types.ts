export interface Tenant {
  id: number;
  full_name: string;
  cpf: string;
  rg: string;
  civil_state: string;
  occupation: string;
  reference_address: string;
  phone: string;
  email: string;
  unit_id: number;
  unit_number: string;
  rent_amount: number;
  due_day: number;
  contract_start: string;
  contract_end: string;
  notes: string;
  profile_photo: string;
  document_front_image: string;
  document_back_image: string;
  active: boolean;
}

export interface AuthPermissions {
  dashboard: boolean;
  properties: boolean;
  tenants: boolean;
  finance: boolean;
  documents: boolean;
  settings: boolean;
}

export interface AuthUser {
  id: number;
  full_name: string;
  email: string;
  role: string;
  is_root: boolean;
  is_active: boolean;
  permissions: AuthPermissions;
}

export interface AuthResponse {
  token: string;
  token_type: string;
  expires_in_hours: number;
  user: AuthUser;
}

export interface PreRegistration {
  id: number;
  full_name: string;
  cpf: string;
  rg: string;
  civil_state: string;
  occupation: string;
  reference_address: string;
  phone: string;
  email: string;
  due_day: number;
  contract_months: number;
  doc_front_image: string;
  doc_back_image: string;
  status: string;
  created_at: string;
}

export type UnitOccupancyStatus = 'occupied' | 'vacant';
export type UnitPaymentStatus = 'paid' | 'overdue' | 'due_soon' | 'vacant' | 'unpaid' | 'disabled';

export interface UnitItem {
  id: number;
  unit_number: string;
  status: UnitOccupancyStatus;
  is_active: boolean;
  inactive_reason: string;
  available_from: string;
  base_rent: number;
  tenant_id: number;
  tenant_name: string;
  payment_status: UnitPaymentStatus;
  month_amount: number;
  due_date: string;
}

export interface UnitPaymentHistoryItem {
  month: string;
  amount: number;
  status: string;
  due_date: string;
  paid_at: string;
  late_fee: number;
  tenant_id: number;
  tenant_name: string;
}

export interface UnitMaintenanceItem {
  id: number;
  description: string;
  ticket_date: string;
  cost: number;
  status: string;
  image_path: string;
}

export interface UnitDetail {
  id: number;
  unit_number: string;
  status: UnitOccupancyStatus;
  is_active: boolean;
  inactive_reason: string;
  available_from: string;
  base_rent: number;
  tenant_id: number;
  tenant_name: string;
  tenant_rent: number;
  due_day: number;
  tenant_cpf: string;
  payment_history: UnitPaymentHistoryItem[];
  maintenance_history: UnitMaintenanceItem[];
}

export interface DashboardSummary {
  expected_rent: number;
  collected: number;
  overdue: number;
  collection_percentage: number;
  paid_tenants: number;
  overdue_tenants: number;
  total_tenants: number;
  vacant_units: number;
  disabled_units: number;
  contracts_expiring_soon: number;
  revenue_vs_previous_month_pct: number;
}

export interface DashboardGridItem {
  id: number;
  unit_number: string;
  tenant_name: string;
  status: UnitPaymentStatus;
  is_active: boolean;
  inactive_reason: string;
  available_from: string;
}

export interface NotificationItem {
  id: number;
  type: string;
  title: string;
  message: string;
  related_id: number;
  created_at: string;
  read: boolean;
}

export interface DocumentTemplate {
  id: number;
  name: string;
  document_type: string;
  template_body: string;
  created_at: string;
}

export interface DocumentItem {
  id: number;
  template_id: number;
  tenant_id: number;
  tenant_name: string;
  document_type: string;
  file_path: string;
  generated_at: string;
  download_url: string;
}

export interface FinanceMonthlyTrend {
  month: string;
  expected: number;
  collected: number;
  overdue: number;
}

export interface FinanceAnalytics {
  year: string;
  monthly_trend: FinanceMonthlyTrend[];
  paid_unpaid_ratio: {
    paid: number;
    unpaid: number;
  };
}

export interface FinanceIntelligence {
  month: string;
  revenue: number;
  expenses: number;
  net_income: number;
  unit_profitability_ranking: Array<{
    unit_id: number;
    unit_number: string;
    net_income: number;
  }>;
}
