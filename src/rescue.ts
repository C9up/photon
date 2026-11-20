/**
 * Reporting for rescued deferred props.
 *
 * `defer(fn, { rescue: true })` keeps a page alive when `fn` throws: the prop is
 * omitted and named in `rescuedProps`, and the client renders its fallback. The
 * error itself must still reach someone, or a broken panel in production is
 * invisible. Upstream reports each one through a listener whose default logs
 * it on the request's logger, and `Inertia.onRescue()` replaces it; photon has
 * no per-request class to hang a static on, so the same listener is set with
 * the exported {@link onRescue}.
 */

import type { SsrRequestContext } from "./PhotonRenderer.js";
import type { RescuedError } from "./props.js";

/** Told about every rescued deferred prop, after the props are resolved. */
export type RescueListener = (
	error: unknown,
	info: {
		/** The failing prop's key. */
		prop: string;
		/** The HTTP context of the request, when the render has one. */
		ctx: SsrRequestContext | undefined;
	},
) => void;

/**
 * The request's logger when it has one (`ctx.logger.error({ err }, message)`,
 * as upstream), `console.error` otherwise — a host without a logger still
 * hears about it.
 */
const defaultListener: RescueListener = (error, { prop, ctx }) => {
	const message = `Rescued deferred prop "${prop}"`;
	const logger = Reflect.get(Object(ctx), "logger");
	if (typeof logger === "object" && logger !== null) {
		const log = Reflect.get(logger, "error");
		if (typeof log === "function") {
			Reflect.apply(log, logger, [{ err: error }, message]);
			return;
		}
	}
	console.error(`[photon] ${message}`, error);
};

let listener: RescueListener = defaultListener;

/**
 * Replace the listener rescued deferred-prop errors are reported to; with no
 * argument, restore the default (the request's logger). Process-wide, as
 * upstream's static `Inertia.onRescue`.
 *
 *   onRescue((error, { prop }) => reporter.capture(error, { tags: { prop } }))
 */
export function onRescue(next?: RescueListener): void {
	listener = next ?? defaultListener;
}

/** Hand each rescued error to the listener. Internal. */
export function reportRescued(
	errors: readonly RescuedError[],
	ctx: SsrRequestContext | undefined,
): void {
	for (const { prop, error } of errors) listener(error, { prop, ctx });
}
