<script>
import { Form, useForm } from "../../../src/client/svelte/index.js";

const form = useForm({ email: "" });
</script>

<section id="use-form">
	<input bind:value={form.email} />
	<button type="button" onclick={() => form.post("/signup")}>go</button>
	<p>{form.errors.email ?? ""}|{form.isDirty ? "dirty" : "clean"}</p>
</section>

<section id="form">
	<Form action="/signup" method="post">
		{#snippet children(state)}
			<input name="email" value="" />
			<button type="submit">go</button>
			<p>{state.errors.email ?? ""}</p>
		{/snippet}
	</Form>
</section>
