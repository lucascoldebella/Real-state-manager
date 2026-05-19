import type { Metadata } from 'next';
import { ClientAuthProvider } from '../../lib/client-auth-context';

export const metadata: Metadata = {
  title: 'Painel do Cliente — Oliveira Costa',
};

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return <ClientAuthProvider>{children}</ClientAuthProvider>;
}
