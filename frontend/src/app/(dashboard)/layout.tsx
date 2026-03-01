import { DashboardLayout } from '../../components/layout/DashboardLayout/DashboardLayout';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
