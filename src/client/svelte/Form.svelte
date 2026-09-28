<!--
  A form the router submits — `Form` from `@inertiajs/svelte` 3.7.1: the data
  is read from its fields at submit, and its children get `errors`,
  `processing`, `isDirty`, `reset`, `submit`… (also on the methods it exports
  and through `useFormContext()`). The logic is Photon's framework-free form
  controller.
-->
<script module lang="ts">
import { getContext } from "svelte";
import type { FormSlotProps } from "../formElement.js";

const FORM_KEY = Symbol("photon:form");

/** The nearest `<Form>`'s state and methods, or undefined outside one. */
export function useFormContext(): FormSlotProps | undefined {
	const holder: unknown = getContext(FORM_KEY);
	if (typeof holder !== "object" || holder === null) return undefined;
	const read: unknown = Reflect.get(holder, "current");
	return typeof read === "function" ? read() : undefined;
}
</script>

<script lang="ts">
	import { onDestroy, onMount, setContext, type Snippet } from "svelte";
	import {
		createFormController,
		type FormComponentOptions,
	} from "../formElement.js";

	interface Props extends FormComponentOptions {
		disableWhileProcessing?: boolean;
		children?: Snippet<[FormSlotProps]>;
		[key: string]: unknown;
	}

	let {
		action = "",
		method = "get",
		headers,
		errorBag,
		transform,
		options,
		onBefore,
		onStart,
		onSuccess,
		onError,
		onFinish,
		onCancel,
		onCancelToken,
		onSubmitComplete,
		resetOnSuccess,
		resetOnError,
		setDefaultsOnSuccess,
		cancelOnUnmount,
		disableWhileProcessing = false,
		children,
		...rest
	}: Props = $props();

	const controller = createFormController(() => ({
		action,
		method,
		headers,
		errorBag,
		transform,
		options,
		onBefore,
		onStart,
		onSuccess,
		onError,
		onFinish,
		onCancel,
		onCancelToken,
		onSubmitComplete,
		resetOnSuccess,
		resetOnError,
		setDefaultsOnSuccess,
		cancelOnUnmount,
	}));
	let exposed: FormSlotProps = $state(controller.getSnapshot());
	const off = controller.subscribe(() => {
		exposed = controller.getSnapshot();
	});
	setContext(FORM_KEY, { current: () => exposed });

	let element: HTMLFormElement | null = $state(null);
	onMount(() => {
		if (element) controller.mount(element);
	});
	onDestroy(() => {
		off();
		controller.unmount();
	});

	export function submit(submitter?: HTMLElement | null) {
		exposed.submit(submitter);
	}
	export function reset(...fields: string[]) {
		exposed.reset(...fields);
	}
	export function clearErrors(...fields: string[]) {
		exposed.clearErrors(...fields);
	}
	export function cancel() {
		exposed.cancel();
	}
	export function defaults() {
		exposed.defaults();
	}
	export function getData() {
		return exposed.getData();
	}
	export function getFormData() {
		return exposed.getFormData();
	}

	function onsubmit(event: SubmitEvent) {
		event.preventDefault();
		exposed.submit(event.submitter);
	}
</script>

<form
	{...rest}
	bind:this={element}
	{action}
	{method}
	inert={disableWhileProcessing && exposed.processing}
	{onsubmit}
>
	{@render children?.(exposed)}
</form>
