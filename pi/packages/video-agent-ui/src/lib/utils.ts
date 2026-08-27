import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并 Tailwind 类名（后者覆盖冲突项） */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
