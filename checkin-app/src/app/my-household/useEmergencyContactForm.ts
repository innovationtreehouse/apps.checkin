import { useState } from 'react';
import { errorMessage, showError, showSuccess } from '@checkin/component-ui';
import { api } from '@/lib/api';
import { notifyNavRefresh } from '@/lib/nav-refresh';
import { isValidPhone, PHONE_ERROR } from '@/lib/phone';
import { isValidEmail } from '@/lib/emergencyContacts/identity';
import { EMAIL_ERROR, type EmergencyContact } from './household';

const blankContactForm = { id: null as number | null, name: "", phone: "", email: "", relationship: "" };

export type ContactFormValues = typeof blankContactForm;
export type ContactErrors = { name?: string; phone?: string; email?: string };

/** The household lead's add/edit emergency-contact form, opened from its card or by a member-change collision. */
export function useEmergencyContactForm() {
  const [values, setValues] = useState(blankContactForm);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // Per-field client validation (red ring + subtext), checked on Add/Save click
  // so phone/email/name errors never flash while the user is still typing.
  const [errors, setErrors] = useState<ContactErrors>({});

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: ContactErrors = {};
    if (!values.name.trim()) errs.name = "Name is required.";
    if (!isValidPhone(values.phone)) errs.phone = PHONE_ERROR;
    if (values.email && !isValidEmail(values.email)) errs.email = EMAIL_ERROR;
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setSaving(true);
    try {
      const editing = values.id !== null;
      const url = editing ? `/api/household/emergency-contacts/${values.id}` : '/api/household/emergency-contacts';
      await api(url, {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify({ name: values.name, phone: values.phone, email: values.email, relationship: values.relationship }),
      });
      showSuccess(editing ? "Emergency contact updated." : "Emergency contact added.");
      setValues(blankContactForm);
      setOpen(false);
      notifyNavRefresh();
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number) => {
    try {
      await api(`/api/household/emergency-contacts/${id}`, { method: 'DELETE' });
      showSuccess("Emergency contact removed.");
      notifyNavRefresh();
    } catch (e) {
      showError(errorMessage(e));
    }
  };

  const startAdd = () => {
    setErrors({});
    setValues(blankContactForm);
    setOpen(true);
  };
  const startEdit = (c: EmergencyContact) => {
    setErrors({});
    setValues({ id: c.id, name: c.name, phone: c.phone, email: c.email || "", relationship: c.relationship || "" });
    setOpen(true);
  };
  const cancel = () => {
    setOpen(false);
    setValues(blankContactForm);
    setErrors({});
  };

  return { values, setValues, open, saving, errors, setErrors, save, remove, startAdd, startEdit, cancel };
}

export type EmergencyContactForm = ReturnType<typeof useEmergencyContactForm>;
