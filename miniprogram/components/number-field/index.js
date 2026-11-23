Component({
  properties: {
    field: String,
    label: String,
    hint: String,
    error: String,
    value: { type: String, optionalTypes: [Number], value: '' },
    keyboard: { type: String, value: 'number' },
    placeholder: String,
    disabled: Boolean,
  },
  data: { focused: false },
  methods: {
    handleFocus() {
      this.setData({ focused: true });
    },
    handleInput(event) {
      this.triggerEvent('fieldinput', event.detail);
    },
    handleBlur(event) {
      this.setData({ focused: false });
      this.triggerEvent('fieldblur', event.detail);
    },
  },
});
