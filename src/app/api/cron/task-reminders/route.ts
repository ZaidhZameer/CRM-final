import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { sendTaskReminderEmail } from '@/lib/email'
import { verifyCronSecret } from '@/lib/automation/secret'

// Called once a day by the n8n lifecycle scheduler.
// GET /api/cron/task-reminders   (header: x-cron-secret)

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request).ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const service = createServiceClient()

  // Get today's date range
  const today = new Date()
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString()
  const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString()

  // Get all tasks due today that are not completed
  const { data: tasks } = await service
    .from('tasks')
    .select(`
      id, title, due_at, priority,
      assigned_to,
      profiles:assigned_to(full_name, user_id)
    `)
    .gte('due_at', startOfDay)
    .lt('due_at', endOfDay)
    .in('status', ['todo', 'in_progress'])

  if (!tasks || tasks.length === 0) {
    return NextResponse.json({ message: 'No tasks due today', sent: 0 })
  }

  // Group tasks by assignee
  const tasksByUser = new Map<string, { name: string; email: string; tasks: { title: string; dueDate: string; priority: string }[] }>()

  for (const task of tasks) {
    const profile = (task as any).profiles
    if (!profile?.user_id) continue

    // Get user email from auth
    const { data: authUser } = await service.auth.admin.getUserById(profile.user_id)
    if (!authUser?.user?.email) continue

    const userId = profile.user_id
    if (!tasksByUser.has(userId)) {
      tasksByUser.set(userId, {
        name: profile.full_name ?? 'Team Member',
        email: authUser.user.email,
        tasks: [],
      })
    }

    tasksByUser.get(userId)!.tasks.push({
      title: task.title,
      dueDate: new Date(task.due_at).toLocaleDateString(),
      priority: task.priority,
    })
  }

  // Send emails
  let sent = 0
  for (const [, user] of tasksByUser) {
    const result = await sendTaskReminderEmail(user.email, user.name, user.tasks)
    if (result.success) sent++
  }

  return NextResponse.json({ message: `Sent ${sent} reminder emails`, sent })
}
