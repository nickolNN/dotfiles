/**
 * Question Tool - Single question with options
 *
 * RPC-compatible: uses `ctx.ui.select` / `ctx.ui.input`, which work in both
 * TUI and RPC mode (RPC emits `extension_ui_request` and blocks until the
 * matching `extension_ui_response` arrives). Falls back to a plain text
 * input when no options are provided.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface OptionWithDesc {
	label: string;
	description?: string;
}

interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
}

// Options with labels and optional descriptions
const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionSchema, { description: "Options for the user to choose from" }),
});

const TYPE_SOMETHING = "Type something.";

export default function question(pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description: "Ask the user a question and let them pick from options. Use when you need user input to proceed.",
		parameters: QuestionParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const labels = params.options.map((o) => o.label);

			function cancelled() {
				return {
					content: [{ type: "text" as const, text: "User cancelled the selection" }],
					details: {
						question: params.question,
						options: labels,
						answer: null,
					} as QuestionDetails,
				};
			}

			if (params.options.length === 0) {
				const value = await ctx.ui.input(params.question, "");
				if (value === undefined) {
					return cancelled();
				}
				return {
					content: [{ type: "text" as const, text: `User wrote: ${value}` }],
					details: {
						question: params.question,
						options: labels,
						answer: value,
					} as QuestionDetails,
				};
			}

			const selected = await ctx.ui.select(params.question, [...labels, TYPE_SOMETHING]);
			if (selected === undefined) {
				return cancelled();
			}

			if (selected === TYPE_SOMETHING) {
				const value = await ctx.ui.input(params.question, "type something...");
				if (value === undefined) {
					return cancelled();
				}
				return {
					content: [{ type: "text" as const, text: `User wrote: ${value}` }],
					details: {
						question: params.question,
						options: labels,
						answer: value,
						wasCustom: true,
					} as QuestionDetails,
				};
			}

			return {
				content: [{ type: "text" as const, text: `User selected: ${selected}` }],
				details: {
					question: params.question,
					options: labels,
					answer: selected,
					wasCustom: false,
				} as QuestionDetails,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", args.question);
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				const labels = opts.map((o: OptionWithDesc) => o.label);
				const numbered = [...labels, TYPE_SOMETHING].map((o, i) => `${i + 1}. ${o}`);
				text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.answer === null) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			if (details.wasCustom) {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.answer),
					0,
					0,
				);
			}
			const idx = details.options.indexOf(details.answer) + 1;
			const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
		},
	});
}