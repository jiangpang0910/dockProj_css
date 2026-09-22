import type { Metadata } from "next";
import { Logo } from "@/components/app/logo";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

// The proxy sends signed-in visitors straight back to `next`, so this only ever renders without a session.
export default async function Page({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  return (
    <div className="scene scene-aerial min-h-dvh">
      <div className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center px-5 py-8 text-center sm:py-10">
        <header className="relative flex w-full justify-center">
          <Logo />
          <ThemeToggle className="absolute right-0" />
        </header>
        <main className="flex flex-1 flex-col items-center justify-center py-16">
          <h1 className="font-display text-[2rem] leading-[1.15] tracking-tight sm:text-[2.6rem]">Sign in</h1>
          <p className="mt-3 text-[15px] text-balance text-ink-muted">Use the username and password you were given.</p>
          <LoginForm next={typeof next === "string" ? next : "/"} />
        </main>
      </div>
    </div>
  );
}
