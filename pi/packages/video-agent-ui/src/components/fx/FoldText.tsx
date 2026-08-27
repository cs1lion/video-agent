/**
 * FoldText：3D 折叠展开标题（react-bits FoldText 的 TS 移植）。
 * 文字按 char/word/line 切片，GSAP 驱动每片绕铰链（上/下/左/右）翻转展开，
 * 折起时叠折痕明暗（creaseShading），展开后归位。
 */

import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import "./FoldText.css";

gsap.registerPlugin(ScrollTrigger);

const HINGE_CONFIG = {
	top: { origin: "50% 0%", rotateX: -92, rotateY: 0 },
	bottom: { origin: "50% 100%", rotateX: 92, rotateY: 0 },
	left: { origin: "0% 50%", rotateX: 0, rotateY: 92 },
	right: { origin: "100% 50%", rotateX: 0, rotateY: -92 },
} as const;

export interface FoldTextProps {
	text: string;
	/** 切片粒度：char / word / line */
	splitBy?: "char" | "word" | "line";
	/** 折叠铰链边 */
	hinge?: keyof typeof HINGE_CONFIG;
	duration?: number;
	stagger?: number;
	ease?: string;
	perspective?: number;
	/** 折痕明暗强度 0-1 */
	creaseShading?: number;
	/** 触发时机：mount / hover / scroll / loop */
	trigger?: "mount" | "hover" | "scroll" | "loop";
	fontSize?: string | number;
	fontWeight?: string | number;
	color?: string;
	className?: string;
	style?: CSSProperties;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const renderWhitespace = (value: string, key: string) =>
	value
		.split(/(\n)/)
		.map((part, index) => {
			if (part === "\n") return <br key={`${key}-br-${index}`} />;
			if (!part) return null;
			return (
				<span className="fold-text-whitespace" key={`${key}-space-${index}`}>
					{part.replace(/ /g, "\u00A0")}
				</span>
			);
		});

export function FoldText({
	text = "Design unfolds",
	splitBy = "char",
	hinge = "top",
	duration = 0.65,
	stagger = 0.045,
	ease = "power3.out",
	perspective = 700,
	creaseShading = 0.55,
	trigger = "mount",
	fontSize = 80,
	fontWeight = 800,
	color = "#f7f2e8",
	className = "",
	style = {},
}: FoldTextProps) {
	const rootRef = useRef<HTMLSpanElement>(null);
	const timelineRef = useRef<gsap.core.Timeline | null>(null);
	const hingeConfig = HINGE_CONFIG[hinge] ?? HINGE_CONFIG.top;
	const safeCrease = clamp(creaseShading, 0, 1);
	const safePerspective = Math.max(120, perspective);

	const segments = useMemo(() => {
		let segmentIndex = 0;
		const renderSegment = (content: string, key: string, split: FoldTextProps["splitBy"]) => {
			segmentIndex += 1;
			return (
				<span
					className="fold-text-segment"
					data-fold-split={split}
					key={key}
					style={{ "--fold-perspective": `${safePerspective}px` } as CSSProperties}
				>
					<span
						className="fold-text-piece"
						data-fold-hinge={hinge}
						style={{ transformOrigin: hingeConfig.origin, "--fold-crease": 0 } as CSSProperties}
					>
						{content || "\u00A0"}
					</span>
				</span>
			);
		};

		if (splitBy === "line") {
			return text.split("\n").map((line, index) => (
				<span className="fold-text-line" key={`line-${index}`}>
					{renderSegment(line, `segment-line-${index}`, "line")}
				</span>
			));
		}
		if (splitBy === "word") {
			return text.split(/(\s+)/).flatMap((part, index) => {
				if (!part) return [];
				if (/^\s+$/.test(part)) return renderWhitespace(part, `ws-${index}`);
				segmentIndex += 1;
				return [renderSegment(part, `segment-word-${segmentIndex}`, "word")];
			});
		}
		return Array.from(text).map((char, index) => {
			if (char === "\n") return <br key={`br-${index}`} />;
			return renderSegment(char === " " ? "\u00A0" : char, `segment-char-${index}`, "char");
		});
	}, [text, splitBy, hinge, hingeConfig.origin, safePerspective]);

	useEffect(() => {
		if (typeof window === "undefined") return undefined;
		const root = rootRef.current;
		if (!root) return undefined;
		const pieces = Array.from(root.querySelectorAll<HTMLElement>(".fold-text-piece"));
		if (!pieces.length) return undefined;

		const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		const activeDuration = reduceMotion ? Math.min(duration, 0.22) : duration;
		const activeStagger = reduceMotion ? Math.min(stagger, 0.02) : stagger;

		const fromVars: gsap.TweenVars = {
			opacity: 0,
			rotateX: reduceMotion ? 0 : hingeConfig.rotateX,
			rotateY: reduceMotion ? 0 : hingeConfig.rotateY,
			"--fold-crease": reduceMotion ? 0 : safeCrease,
			transformOrigin: hingeConfig.origin,
			force3D: true,
		};
		const toVars: gsap.TweenVars = {
			opacity: 1,
			rotateX: 0,
			rotateY: 0,
			"--fold-crease": 0,
			duration: activeDuration,
			ease: reduceMotion ? "power1.out" : ease,
			stagger: activeStagger,
			clearProps: "willChange",
		};

		const killTimeline = () => {
			timelineRef.current?.kill();
			timelineRef.current = null;
			gsap.killTweensOf(pieces);
		};

		const play = (repeat: boolean) => {
			killTimeline();
			timelineRef.current = gsap.timeline({ repeat: repeat ? -1 : 0, repeatDelay: repeat ? 0.75 : 0 });
			timelineRef.current.fromTo(pieces, fromVars, toVars);
			return timelineRef.current;
		};

		let scrollTrigger: ScrollTrigger | undefined;
		let hoverHandler: (() => void) | undefined;
		if (trigger === "hover") {
			gsap.set(pieces, { opacity: 1, rotateX: 0, rotateY: 0, "--fold-crease": 0, transformOrigin: hingeConfig.origin });
			hoverHandler = () => play(false);
			root.addEventListener("mouseenter", hoverHandler);
		} else if (trigger === "scroll") {
			gsap.set(pieces, fromVars);
			scrollTrigger = ScrollTrigger.create({
				trigger: root,
				start: "top 82%",
				once: true,
				onEnter: () => play(false),
			});
		} else if (trigger === "loop") {
			play(true);
		} else {
			play(false);
		}

		return () => {
			if (hoverHandler) root.removeEventListener("mouseenter", hoverHandler);
			scrollTrigger?.kill();
			killTimeline();
		};
	}, [
		text,
		splitBy,
		hinge,
		duration,
		stagger,
		ease,
		perspective,
		safeCrease,
		trigger,
		hingeConfig.origin,
		hingeConfig.rotateX,
		hingeConfig.rotateY,
	]);

	const rootStyle = {
		"--fold-text-font-size": typeof fontSize === "number" ? `${fontSize}px` : fontSize,
		"--fold-text-font-weight": fontWeight,
		"--fold-text-color": color,
		...style,
	} as CSSProperties;

	return (
		<span ref={rootRef} className={`fold-text ${className}`.trim()} style={rootStyle}>
			<span className="fold-text-sr-only">{text}</span>
			<span className="fold-text-visual" aria-hidden="true">
				{segments}
			</span>
		</span>
	);
}
