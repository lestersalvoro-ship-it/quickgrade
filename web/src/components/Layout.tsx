import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { BarChart3, BookOpenCheck, GraduationCap, LayoutDashboard, LogOut, Menu, ScanLine, Settings, Sparkles, Users, X } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { post } from '../lib/api';
import { cx } from './ui';

export const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/quizzes', label: 'Quizzes', icon: BookOpenCheck },
  { to: '/classes', label: 'Classes', icon: GraduationCap },
  { to: '/students', label: 'Students', icon: Users },
  { to: '/scan', label: 'Scan & Grade', icon: ScanLine },
  { to: '/results', label: 'Results', icon: BarChart3 },
  { to: '/ai', label: 'AI Assistant', icon: Sparkles },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2 font-semibold tracking-tight text-ink', className)}>
      <img src="/icon.svg" alt="" className="size-8" />
      <span className="text-lg">
        Quick<span className="text-primary">Grade</span>
      </span>
    </span>
  );
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <ul className="space-y-0.5">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <li key={to}>
          <NavLink
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-primary-soft text-primary-soft-text' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')
            }
          >
            <Icon className="size-[18px]" aria-hidden />
            {label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function UserBox() {
  const { user, setUser } = useAuth();
  const nav = useNavigate();
  return (
    <div className="border-t border-line p-3">
      <div className="truncate px-2 text-sm font-medium text-ink">{user?.fullName}</div>
      <div className="truncate px-2 text-xs text-ink-3">{user?.email}</div>
      <button
        className="mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink"
        onClick={async () => {
          await post('/auth/logout').catch(() => {});
          setUser(null);
          nav('/login');
        }}
      >
        <LogOut className="size-4" aria-hidden /> Sign out
      </button>
    </div>
  );
}

export function AppLayout() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  return (
    <div className="min-h-dvh md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside className="no-print sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
        <div className="px-4 py-4">
          <Logo />
        </div>
        <nav className="flex-1 overflow-y-auto px-2" aria-label="Main">
          <NavItems />
        </nav>
        <UserBox />
      </aside>

      {/* Mobile top bar + drawer */}
      <header className="no-print sticky top-0 z-30 flex items-center justify-between border-b border-line bg-surface/95 px-4 py-2.5 backdrop-blur md:hidden">
        <Logo />
        <button className="rounded-lg p-2 text-ink-2 hover:bg-surface-2" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}>
          <Menu className="size-6" />
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 right-0 flex w-72 max-w-[85%] flex-col bg-surface shadow-xl">
            <div className="flex items-center justify-between px-4 py-3">
              <Logo />
              <button className="rounded-lg p-2 text-ink-2 hover:bg-surface-2" onClick={() => setOpen(false)} aria-label="Close menu">
                <X className="size-6" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto px-2" aria-label="Main">
              <NavItems onNavigate={() => setOpen(false)} />
            </nav>
            <UserBox />
          </div>
        </div>
      )}

      <main id="main" className="min-w-0 flex-1 px-4 pb-28 pt-5 sm:px-6 md:pb-10 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>

      {/* Mobile quick bar */}
      <nav className="no-print fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Quick">
        {[NAV[0], NAV[1], NAV[4], NAV[5]].map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => cx('flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium', isActive ? 'text-primary' : 'text-ink-3')}>
            <Icon className="size-5" aria-hidden />
            {label === 'Scan & Grade' ? 'Scan' : label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Logo className="mb-6" />
      <div className="card w-full max-w-md p-6 sm:p-8">{children}</div>
      <p className="mt-6 max-w-md text-center text-xs text-ink-3">Scan bubble answer sheets with your phone, grade instantly and understand where your class needs help.</p>
    </div>
  );
}
