/**
 * 参考图上传器：拖拽 / 点选，dataUrl 上传到服务端后以 id 登记。
 * 上限 4 张、单张 ≤10MB，格式 PNG/JPEG/WEBP/GIF。
 */

import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { ImagePlus, LoaderCircle, X } from "lucide-react";
import { api, type UploadedImage } from "@/api/client";
import { cn } from "@/lib/utils";

const MAX_IMAGES = 4;
const MAX_BYTES = 10 * 1024 * 1024;

const ACCEPT = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function readAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
		reader.readAsDataURL(file);
	});
}

export function ImageUploader({
	value,
	onChange,
}: {
	value: UploadedImage[];
	onChange: (next: UploadedImage[]) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function ingest(files: Iterable<File>): Promise<void> {
		const room = MAX_IMAGES - value.length;
		if (room <= 0) return;
		let used = 0;
		setBusy(true);
		setError(null);
		const added: UploadedImage[] = [];
		try {
			for (const file of files) {
				if (used >= room) break;
				if (!ACCEPT.has(file.type) || file.size === 0 || file.size > MAX_BYTES) continue;
				const dataUrl = await readAsDataUrl(file);
				added.push(await api.uploadImage(file.name, dataUrl));
				used += 1;
			}
			if (added.length > 0) onChange([...value, ...added]);
			else setError("仅支持 10MB 内的 PNG/JPEG/WEBP/GIF 图片");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div>
			<input
				ref={inputRef}
				type="file"
				accept="image/png,image/jpeg,image/webp,image/gif"
				multiple
				className="hidden"
				onChange={(e) => {
					if (e.target.files) void ingest(e.target.files);
					e.target.value = "";
				}}
			/>
			<div className="flex flex-wrap items-center gap-3">
				{value.map((img, idx) => (
					<motion.div
						key={img.id}
						initial={{ opacity: 0, scale: 0.85 }}
						animate={{ opacity: 1, scale: 1 }}
						className="group relative size-20 overflow-hidden rounded-xl border border-white/15"
					>
						<img src={img.url} alt={img.name} className="size-full object-cover" />
						<button
							type="button"
							onClick={() => onChange(value.filter((_, i) => i !== idx))}
							className="absolute top-1 right-1 cursor-pointer rounded-full bg-black/70 p-1 text-zinc-300 opacity-0 transition-opacity group-hover:opacity-100 hover:text-white"
							aria-label="移除图片"
						>
							<X className="size-3" />
						</button>
					</motion.div>
				))}
				{value.length < MAX_IMAGES && (
					<button
						type="button"
						onClick={() => inputRef.current?.click()}
						onDragOver={(e) => {
							e.preventDefault();
							setDragging(true);
						}}
						onDragLeave={() => setDragging(false)}
						onDrop={(e) => {
							e.preventDefault();
							setDragging(false);
							void ingest(e.dataTransfer.files);
						}}
						className={cn(
							"flex size-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-zinc-500 transition-colors",
							dragging ? "border-cyan-300/70 bg-cyan-400/10 text-cyan-200" : "border-white/20 hover:border-white/40 hover:text-zinc-300",
						)}
					>
						{busy ? (
							<LoaderCircle className="size-5 animate-spin" />
						) : (
							<>
								<ImagePlus className="size-5" />
								<span className="text-[10px]">上传参考图</span>
							</>
						)}
					</button>
				)}
			</div>
			{error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
			<p className="mt-2 text-xs text-zinc-500">
						可选。上传产品照 / 场景图 / 人物设定，美术指导会在美术设计与分镜中参考它们（最多 {MAX_IMAGES} 张）。
			</p>
		</div>
	);
}
