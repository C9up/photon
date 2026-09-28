<script>
/** @type {{ label: string }} */
let { label } = $props();
let clicks = $state(0);
</script>

<button type="button" onclick={() => clicks++}>{label}:{clicks}</button>
