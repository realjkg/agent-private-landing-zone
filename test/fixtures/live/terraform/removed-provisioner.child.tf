removed {
  from = terraform_data.gone2
  lifecycle { destroy = true }
  provisioner "local-exec" {
    when    = destroy
    command = "echo removed2"
  }
}
