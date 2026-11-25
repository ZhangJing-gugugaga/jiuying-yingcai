const { reportAmountText } = require('../../utils/format');

Component({
  properties: {
    field: String,
    label: String,
    hint: String,
    error: String,
    value: { type: String, optionalTypes: [Number], value: '' },
    keyboard: { type: String, value: 'number' },
    formatAmount: Boolean,
    placeholder: String,
    disabled: Boolean,
    required: Boolean,
    focus: Boolean,
    confirmType: { type: String, value: 'done' },
  },
  data: { focused: false, formattedValue: '' },
  observers: {
    'value, formatAmount'(value, formatAmount) {
      const formattedValue = formatAmount ? reportAmountText(value) : '';
      if (formattedValue !== this.data.formattedValue) this.setData({ formattedValue });
    },
  },
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
    handleConfirm(event) {
      this.triggerEvent('fieldconfirm', event.detail);
    },
    handleKeyboardHeightChange(event) {
      this.triggerEvent('fieldkeyboard', event.detail);
    },
  },
});
