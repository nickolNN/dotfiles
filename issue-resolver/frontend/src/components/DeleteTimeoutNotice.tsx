interface DeleteTimeoutNoticeProps {
  message: string | null;
}

export default function DeleteTimeoutNotice({
  message,
}: DeleteTimeoutNoticeProps) {
  if (!message) return null;
  return (
    <p
      role="alert"
      data-testid="delete-timeout"
      className="mb-4 text-sm font-medium text-[#FFB000]"
    >
      {message}
    </p>
  );
}
