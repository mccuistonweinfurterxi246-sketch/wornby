import { Toaster as Sonner } from "sonner"
import * as React from "react"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-card group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-white/50",
          actionButton:
            "group-[.toast]:bg-emerald-500 group-[.toast]:text-black",
          cancelButton:
            "group-[.toast]:bg-white/10 group-[.toast]:text-white",
          success: "group-[.toaster]:border-emerald-500/50 group-[.toaster]:bg-emerald-950/20",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
