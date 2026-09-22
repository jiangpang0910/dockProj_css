"use client";
import { useActionState } from "react";
import { Loader2, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { login, type LoginState } from "./actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  return (
    <form action={action} className="mt-8 w-full max-w-xs space-y-4 rounded-xl border bg-surface p-5 text-left shadow-sm">
      <input type="hidden" name="next" value={next} />
      <div className="space-y-1.5">
        <Label htmlFor="user">Username</Label>
        <Input id="user" name="user" autoComplete="username" autoFocus required maxLength={40} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {state.error && <p role="alert" className="rounded-md border border-signal/40 bg-signal-soft px-3 py-2 text-sm">{state.error}</p>}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : <LogIn />} Sign in
      </Button>
    </form>
  );
}
