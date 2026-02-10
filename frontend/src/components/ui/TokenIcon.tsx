import { Token } from "@/types";

interface TokenIconProps {
  token: Token;
  size?: "sm" | "md";
}

export default function TokenIcon({ token, size = "md" }: TokenIconProps) {
  const sizeClass = size === "sm" ? "w-5 h-5 text-[8px]" : "w-6 h-6 text-[10px]";

  return (
    <div
      className={`${sizeClass} rounded-full ${token.color} flex items-center justify-center font-medium`}
    >
      {token.symbol[0]}
    </div>
  );
}
